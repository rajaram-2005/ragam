#!/usr/bin/env python3
"""Aetheris Fabric — HTTP surface.

Thin by design: the pipeline, ledger, registry and failure memory are all usable
as a library, and this module only binds a socket to them so ``services/core`` can
reach Fabric over ``AETHERIS_FABRIC_BASE_URL``.

Two things this service must never do:

* **Report a blocked stage as a success.** ``/status`` lists exactly which stages
  can run on this host and which cannot, with the reason. A caller that trains a
  model through here gets the same honest record it would get from the library.
* **Run anything an unauthorised caller asks for.** There are no credentials in
  this service and no route that accepts one; it binds to **loopback by default**
  (``AETHERIS_FABRIC_HOST`` opts into anything wider, with a warning printed), and
  ``/status`` reports the same recommendation.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from . import __version__
from .failure_memory import FailureMemory
from .modelcards import ModelReleaseManager
from .pipeline import STAGE_NAMES, Pipeline, PipelineConfig
from .run import code_revision, hardware_profile
from .taxonomy import StageStatus

__all__ = ["FabricService", "create_server", "main"]

MAX_BODY_BYTES = 1 << 20  # 1 MB: this service takes small JSON commands, not data.

# Loopback by DEFAULT. This service performs no authentication, so a wider bind must
# be an explicit opt-in rather than something that happens by accident.
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8791
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


class FabricService:
    """Holds the state the HTTP routes expose."""

    def __init__(self, *, output_dir: str | Path | None = None, default_config: PipelineConfig | None = None) -> None:
        self.output_dir = Path(output_dir) if output_dir else None
        self.default_config = default_config or PipelineConfig()
        self.registry = ModelReleaseManager()
        self.failures = FailureMemory()
        self.runs: list[dict] = []
        self._lock = threading.Lock()

    # --- pipeline ---------------------------------------------------------

    def run_pipeline(self, overrides: dict | None = None, *, stages: tuple[str, ...] | None = None) -> dict:
        """Run the pipeline and return its record.

        Serialised behind a lock: two concurrent runs on two CPU cores would each
        take longer and would contend for the same memory, so the timings recorded
        in the run record would not mean anything.
        """
        config = self._config_from(overrides or {})
        pipeline = Pipeline(config, output_dir=self.output_dir)
        with self._lock:
            record = pipeline.run(stages=stages or STAGE_NAMES)
        # The registry and failure memory are shared, so a run can promote a model.
        for identifier, card in pipeline.registry.cards.items():
            if identifier not in self.registry.cards:
                self.registry.cards[identifier] = card
        self.registry._released.extend(
            entry for entry in pipeline.registry.release_history() if entry not in self.registry._released
        )
        payload = record.to_dict()
        self.runs.append(payload)
        return payload

    def _config_from(self, overrides: dict) -> PipelineConfig:
        """Build a config from JSON overrides, refusing unknown or invalid keys."""
        base = self.default_config.as_dict()
        unknown = sorted(set(overrides) - set(base))
        if unknown:
            raise ValueError(f"unknown pipeline option(s): {', '.join(unknown)}")

        # JSON keys are camelCase; the dataclass is snake_case.
        mapping = {
            "dataSeed": "data_seed", "splitBy": "split_by", "evaluationFraction": "evaluation_fraction",
            "modelSeed": "model_seed", "dModel": "d_model", "dEmb": "d_emb", "batchSize": "batch_size",
            "learningRate": "learning_rate", "candidateDims": "candidate_dims",
            "candidateEpochs": "candidate_epochs", "modelName": "model_name",
            "modelVersion": "model_version", "minMrr": "min_mrr", "maxLatencyMs": "max_latency_ms",
            "evaluateTopicSplit": "evaluate_topic_split",
        }
        kwargs = {}
        for key, value in overrides.items():
            kwargs[mapping.get(key, key)] = tuple(value) if isinstance(value, list) else value
        current = {key: getattr(self.default_config, key) for key in vars(self.default_config)}
        current.update(kwargs)
        return PipelineConfig(**current)

    # --- status -----------------------------------------------------------

    def status(self) -> dict:
        """What this host can and cannot do, stated plainly."""
        profile = hardware_profile()
        runnable, blocked = [], []
        probe = Pipeline(self.default_config)
        for name in STAGE_NAMES:
            if name in ("sft", "preference_optimization", "distillation"):
                result = getattr(probe, name)()
                blocked.append({"stage": name, "status": result.status.value, "reason": result.detail["reason"]})
            else:
                runnable.append(name)
        return {
            "service": "aetheris-fabric",
            "version": __version__,
            "status": "degraded" if blocked else "ready",
            "hardware": profile,
            "codeRevision": code_revision(),
            "stages": {
                "total": len(STAGE_NAMES),
                "runnable": runnable,
                "blocked": blocked,
            },
            "models": self.registry.summary(),
            "runs": len(self.runs),
            "failures": self.failures.summary(),
            "security": {
                "acceptsCredentials": False,
                "bindRecommendation": "loopback or private network only; this service performs no authentication",
            },
        }


def _json_response(handler: "Handler", status: int, payload: Any) -> None:
    body = json.dumps(payload, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(body)))
    handler.send_header("cache-control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _error(handler: "Handler", status: int, code: str, message: str, **extra: Any) -> None:
    _json_response(handler, status, {"error": code, "message": message, **extra})


class Handler(BaseHTTPRequestHandler):
    service: FabricService

    server_version = "AetherisFabric/0.1"
    protocol_version = "HTTP/1.1"

    # Silence per-request logging on stderr; the service reports through its routes.
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        return

    # --- plumbing ---------------------------------------------------------

    def _drain(self, length: int) -> None:
        """Consume a body we are not going to parse.

        Without this the client is still writing when we answer, and gets a broken
        pipe instead of the 413 that explains what happened.
        """
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                return
            remaining -= len(chunk)

    def _read_body(self) -> dict:
        declared = self.headers.get("content-length")
        if declared is None:
            return {}
        try:
            length = int(declared)
        except ValueError:
            raise ValueError("content-length must be an integer")
        if length > MAX_BODY_BYTES:
            self._drain(length)
            raise OverflowError(f"request body exceeds the {MAX_BODY_BYTES >> 20} MB limit")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"invalid JSON body: {error}") from None
        if not isinstance(parsed, dict):
            raise ValueError("the request body must be a JSON object")
        return parsed

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib naming
        self.send_response(204)
        self.send_header("allow", "GET, POST, OPTIONS")
        self.send_header("content-length", "0")
        self.end_headers()

    # --- GET --------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        query = parse_qs(url.query)
        service = self.service

        if path in ("/", "/health"):
            return _json_response(self, 200, {"status": "ok", "service": "aetheris-fabric"})
        if path == "/status":
            return _json_response(self, 200, service.status())
        if path == "/stages":
            return _json_response(self, 200, {"stages": list(STAGE_NAMES)})
        if path == "/runs":
            limit = int(query.get("limit", ["20"])[0])
            return _json_response(self, 200, {"runs": service.runs[-max(1, limit):]})
        if path == "/models":
            status = query.get("status", [None])[0]
            cards = service.registry.list(status=status)
            return _json_response(self, 200, {"models": [card.to_dict() for card in cards], "summary": service.registry.summary()})
        if path == "/models/current":
            card = service.registry.current()
            if card is None:
                return _error(self, 404, "no_release", "no model has been released")
            return _json_response(self, 200, card.to_dict())
        if path == "/experiments":
            return _json_response(self, 200, {"summary": service.registry.summary(), "runs": len(service.runs)})
        if path == "/failures":
            return _json_response(self, 200, service.failures.to_dict())
        return _error(self, 404, "not_found", f"no route for GET {path}")

    # --- POST -------------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        service = self.service

        try:
            body = self._read_body()
        except OverflowError as error:
            return _error(self, 413, "body_too_large", str(error))
        except ValueError as error:
            return _error(self, 400, "invalid_request", str(error))

        try:
            if path == "/pipeline/run":
                stages = body.get("stages")
                if stages is not None and not isinstance(stages, list):
                    return _error(self, 400, "invalid_request", "'stages' must be a list of stage names")
                record = service.run_pipeline(
                    body.get("config") or {},
                    stages=tuple(stages) if stages else None,
                )
                return _json_response(self, 200, record)
            if path == "/failures/capture":
                record = service.failures.capture(**body)
                return _json_response(self, 201, record.to_dict())
        except TypeError as error:
            return _error(self, 400, "invalid_request", str(error))
        except ValueError as error:
            return _error(self, 400, "invalid_request", str(error))
        except KeyError as error:
            return _error(self, 404, "not_found", str(error))
        except Exception as error:  # noqa: BLE001 - never leak a traceback to a client
            return _error(self, 500, "internal_error", f"{type(error).__name__}: {error}")
        return _error(self, 404, "not_found", f"no route for POST {path}")


def create_server(service: FabricService | None = None, *, host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    """Build (but do not start) the HTTP server."""
    handler = type("BoundHandler", (Handler,), {"service": service or FabricService()})
    return ThreadingHTTPServer((host, port), handler)


def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    host = os.environ.get("AETHERIS_FABRIC_HOST", DEFAULT_HOST)
    port = int(os.environ.get("AETHERIS_FABRIC_PORT", str(DEFAULT_PORT)))
    data_dir = os.environ.get("AETHERIS_FABRIC_DATA_DIR")

    if "--help" in args or "-h" in args:
        print(__doc__)
        return 0

    service = FabricService(output_dir=data_dir)
    server = create_server(service, host=host, port=port)
    bound = server.server_address
    print("aetheris-fabric listening")
    print(f"  url       http://{bound[0]}:{bound[1]}")
    print(f"  data dir  {data_dir or '(in memory)'}")
    print(f"  revision  {code_revision() or 'unknown'}")

    status = service.status()
    runnable = status["stages"]["runnable"]
    blocked = status["stages"]["blocked"]
    print(f"  status    {status['status']} ({len(runnable)}/{status['stages']['total']} stages runnable here)")
    for entry in blocked:
        print(f"  blocked   {entry['stage']}: {entry['reason']}")
    if host not in LOOPBACK_HOSTS:
        print(f"  warning   bound to {host}; this service performs NO authentication")
        print("            set AETHERIS_FABRIC_HOST=127.0.0.1 unless a wider bind is intended")

    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("aetheris-fabric: shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

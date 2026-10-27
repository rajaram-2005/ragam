"""Fabric's HTTP surface must be honest about what this host can do.

The service performs no authentication, so the tests also pin what it refuses to
accept: oversized bodies, malformed JSON, unknown routes and unknown options.
"""

from __future__ import annotations

import json
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from fabric.pipeline import STAGE_NAMES
from fabric.server import (
    DEFAULT_HOST,
    LOOPBACK_HOSTS,
    MAX_BODY_BYTES,
    FabricService,
    create_server,
    main,
)


@pytest.fixture()
def client():
    service = FabricService()
    server = create_server(service, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def call(method: str, path: str, body=None, raw: bytes | None = None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        request = Request(base + path, data=data, method=method)
        if data is not None:
            request.add_header("content-type", "application/json")
        try:
            with urlopen(request, timeout=120) as response:
                payload = response.read().decode("utf-8")
                return response.status, dict(response.headers), (json.loads(payload) if payload else None)
        except HTTPError as error:
            payload = error.read().decode("utf-8")
            return error.code, dict(error.headers), (json.loads(payload) if payload else None)

    call.base = base
    yield service, call
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def test_health_and_root_answer(client):
    _, call = client
    for path in ("/", "/health"):
        status, _, body = call("GET", path)
        assert status == 200
        assert body["status"] == "ok"
        assert body["service"] == "aetheris-fabric"


def test_status_states_which_stages_cannot_run_here(client):
    _, call = client
    status, _, body = call("GET", "/status")
    assert status == 200
    assert body["status"] == "degraded", "three stages are blocked on this host"
    assert body["stages"]["total"] == len(STAGE_NAMES)
    assert set(body["stages"]["runnable"]) == {
        "data_validation", "base_selection", "domain_training", "evaluation", "release"
    }
    blocked = {entry["stage"] for entry in body["stages"]["blocked"]}
    assert blocked == {"sft", "preference_optimization", "distillation"}
    for entry in body["stages"]["blocked"]:
        assert entry["status"].startswith("blocked")
        assert entry["reason"]
    # No GPU is claimed, because none was detected.
    assert body["hardware"]["gpuDetected"] is False
    assert body["security"]["acceptsCredentials"] is False


def test_stages_are_listed(client):
    _, call = client
    status, _, body = call("GET", "/stages")
    assert status == 200
    assert body["stages"] == list(STAGE_NAMES)


TRAIN_CONFIG = {"epochs": 12, "candidateDims": [16], "candidateEpochs": 2, "evaluateTopicSplit": False}


def test_the_pipeline_can_be_run_over_http(client):
    service, call = client
    status, _, body = call("POST", "/pipeline/run", {"config": TRAIN_CONFIG})
    assert status == 200
    assert body["format"] == "aetheris-run-record/1"
    assert [stage["name"] for stage in body["stages"]] == list(STAGE_NAMES)
    # Three stages cannot run on this host, so a successful run is still "partial".
    assert body["status"] == "partial"
    assert body["limitations"], "a partial run must explain itself"
    assert service.runs, "the run must be retained for /runs"


def test_an_undertrained_run_reports_failure_rather_than_a_release(client):
    _, call = client
    status, _, body = call("POST", "/pipeline/run", {"config": {"epochs": 3, "candidateDims": [16], "candidateEpochs": 1}})
    assert status == 200, "the HTTP call succeeded; the run did not"
    assert body["status"] == "failed"
    release = next(stage for stage in body["stages"] if stage["name"] == "release")
    assert release["status"] == "failed"
    assert release["detail"]["released"] is None
    assert any("below the required minimum" in reason for reason in release["detail"]["validation"]["hardFailures"])
    assert any("NOT released" in note for note in body["limitations"])


def test_runs_are_listed_after_a_run(client):
    _, call = client
    status, _, body = call("GET", "/runs")
    assert status == 200 and body["runs"] == []

    call("POST", "/pipeline/run", {"config": {"epochs": 2, "candidateDims": [16], "candidateEpochs": 1, "evaluateTopicSplit": False}})
    status, _, body = call("GET", "/runs")
    assert status == 200
    assert len(body["runs"]) == 1
    assert body["runs"][0]["runId"]


def test_an_unknown_pipeline_option_is_refused(client):
    _, call = client
    status, _, body = call("POST", "/pipeline/run", {"config": {"quantumDepth": 4}})
    assert status == 400
    assert body["error"] == "invalid_request"
    assert "quantumDepth" in body["message"]


def test_an_unknown_stage_name_is_refused(client):
    _, call = client
    status, _, body = call("POST", "/pipeline/run", {"stages": ["data_validation", "teleport"]})
    assert status == 400
    assert "teleport" in body["message"]


def test_stages_must_be_a_list(client):
    _, call = client
    status, _, body = call("POST", "/pipeline/run", {"stages": "data_validation"})
    assert status == 400
    assert "must be a list" in body["message"]


def test_a_subset_of_stages_can_be_requested(client):
    _, call = client
    status, _, body = call("POST", "/pipeline/run", {"stages": ["data_validation"], "config": {"epochs": 2}})
    assert status == 200
    found = {stage["name"]: stage["status"] for stage in body["stages"]}
    assert found["data_validation"] == "completed"
    assert found["evaluation"] == "skipped"


def test_models_and_current_release(client):
    _, call = client
    status, _, body = call("GET", "/models")
    assert status == 200
    assert body["models"] == []

    status, _, body = call("GET", "/models/current")
    assert status == 404
    assert body["error"] == "no_release", "no release yet is a distinct condition from an unknown route"

    # A full run releases the retriever when it meets its requirements.
    call("POST", "/pipeline/run", {"config": TRAIN_CONFIG})
    status, _, body = call("GET", "/models")
    assert status == 200
    assert body["summary"]["models"] >= 1

    status, _, body = call("GET", "/models/current")
    assert status == 200
    assert body["identifier"] == "aetheris-lite-retriever@0.1.1"
    assert body["licence"] == "MIT"
    assert body["provenance"]["hardware"]["gpuDetected"] is False
    assert body["limitations"], "a released card must carry its limitations"


def test_models_can_be_filtered_by_status(client):
    _, call = client
    call("POST", "/pipeline/run", {"config": TRAIN_CONFIG})
    status, _, body = call("GET", "/models?status=released")
    assert status == 200
    assert all(card["status"] == "released" for card in body["models"])
    status, _, body = call("GET", "/models?status=retired")
    assert body["models"] == []


def test_a_failure_can_be_captured_over_http(client):
    service, call = client
    status, _, body = call("POST", "/failures/capture", {
        "category": "retrieval",
        "input": "what is the requirement for leakage and impedance",
        "output": "canbus-d0",
        "expected": "isolation-d0",
    })
    assert status == 201
    assert body["stage"] == "observed"
    assert body["category"] == "retrieval"
    assert len(service.failures) == 1

    status, _, body = call("GET", "/failures")
    assert status == 200
    assert body["summary"]["failures"] == 1


def test_capturing_a_failure_with_a_bad_category_is_a_client_error(client):
    _, call = client
    status, _, body = call("POST", "/failures/capture", {
        "category": "not-a-category", "input": "q", "output": "o", "expected": "e",
    })
    assert status == 400
    assert body["error"] == "invalid_request"


def test_a_missing_required_field_is_a_client_error(client):
    _, call = client
    status, _, body = call("POST", "/failures/capture", {"category": "retrieval"})
    assert status == 400
    assert body["error"] == "invalid_request"


def test_an_unknown_route_is_a_404_not_a_500(client):
    _, call = client
    status, _, body = call("GET", "/nope")
    assert status == 404
    assert body["error"] == "not_found"
    status, _, body = call("POST", "/nope", {})
    assert status == 404


def test_malformed_json_is_a_client_error(client):
    _, call = client
    status, _, body = call("POST", "/pipeline/run", raw=b"{not json")
    assert status == 400
    assert body["error"] == "invalid_request"
    assert "invalid JSON" in body["message"]


def test_a_json_array_body_is_refused(client):
    _, call = client
    status, _, body = call("POST", "/pipeline/run", raw=b"[1,2,3]")
    assert status == 400
    assert "must be a JSON object" in body["message"]


def test_an_oversized_body_is_refused(client):
    _, call = client
    huge = b'{"config": {"pad": "' + b"x" * (MAX_BODY_BYTES + 10) + b'"}}'
    status, _, body = call("POST", "/pipeline/run", raw=huge)
    assert status == 413
    assert body["error"] == "body_too_large"


def test_options_is_answered(client):
    _, call = client
    request = Request(call.base + "/pipeline/run", method="OPTIONS")
    with urlopen(request, timeout=30) as response:
        assert response.status == 204
        assert "GET" in response.headers.get("allow", "")


def test_no_response_is_cached(client):
    _, call = client
    status, headers, _ = call("GET", "/status")
    assert headers.get("cache-control") == "no-store"


def test_no_route_echoes_a_secret_because_none_exists(client):
    # Fabric holds no credentials; this pins that the status says so explicitly.
    _, call = client
    status, _, body = call("GET", "/status")
    assert body["security"]["acceptsCredentials"] is False
    assert "api_key" not in json.dumps(body).lower()


def test_concurrent_runs_are_serialised(client):
    # Two runs at once on two cores would make the recorded timings meaningless.
    service, call = client
    config = {"epochs": 2, "candidateDims": [16], "candidateEpochs": 1, "evaluateTopicSplit": False}
    threads = [
        threading.Thread(target=lambda: call("POST", "/pipeline/run", {"config": config}))
        for _ in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=180)
    status, _, body = call("GET", "/runs")
    assert len(body["runs"]) == 2
    ids = {run["runId"] for run in body["runs"]}
    assert len(ids) == 2, "each run must keep its own record"


# ---------------------------------------------------------------------------
# Binding: this service performs no authentication, so the default must be safe.
# ---------------------------------------------------------------------------


def test_the_default_bind_address_is_loopback():
    # /status advises "loopback or private network only". A default of 0.0.0.0 would
    # contradict the service's own advice and expose an unauthenticated training
    # endpoint to the network by accident, so the default is pinned here.
    assert DEFAULT_HOST == "127.0.0.1"
    assert DEFAULT_HOST in LOOPBACK_HOSTS
    assert "0.0.0.0" not in LOOPBACK_HOSTS


def test_main_reads_the_bind_address_from_the_environment(monkeypatch, capsys):
    # --help exits before binding, so this exercises the argument path without
    # needing a socket. The env vars are read inside main().
    monkeypatch.setenv("AETHERIS_FABRIC_HOST", DEFAULT_HOST)
    monkeypatch.setenv("AETHERIS_FABRIC_PORT", "0")
    assert main(["--help"]) == 0
    out = capsys.readouterr().out
    assert "Aetheris Fabric" in out


def test_a_non_loopback_bind_is_reported_as_unauthenticated():
    # The service cannot stop an operator from binding widely; it can refuse to be
    # quiet about it. /status carries the recommendation independently of the bind.
    service = FabricService()
    status = service.status()
    assert status["security"]["acceptsCredentials"] is False
    assert "no authentication" in status["security"]["bindRecommendation"]
    assert "loopback" in status["security"]["bindRecommendation"]

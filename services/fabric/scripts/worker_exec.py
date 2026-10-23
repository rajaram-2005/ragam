#!/usr/bin/env python3
"""Typed local-worker subcommand backend invoked strictly by `KlyvaronLocalWorkerServer`
and `NativeMultimodalHost`.

Never executes shell commands or arbitrary Python strings: accepts only a JSON spec file
for fixed typed operations (`inspect`, `validate`, `qualify`, `infer`, `train`) across all four
Klyvaron first-party modalities (`chat`/`text`, `image`, `video`, `voice`).
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import platform
import signal
import sys
import time

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fabric.lm.adapter import (
    ADAPTER_FORMAT,
    LoRAAdapter,
    TrainingCancelledError,
    TrainingLimitExceededError,
    default_conditioning,
    encode_input_target_example,
    evaluate_batches_loss,
    find_manifest_file,
    greedy_generate_reply,
    load_installed_klyvaron_model,
    peak_rss_bytes,
    run_worker_training_job,
)
from fabric.multimodal.adapter import (
    MULTIMODAL_ADAPTER_FORMAT,
    apply_multimodal_adapter,
    run_multimodal_training_job,
)
from fabric.multimodal.common import MULTIMODAL_FORMAT, load_multimodal_package
from fabric.multimodal.image_model import KlyvaronImageRuntime, parse_size_spec
from fabric.multimodal.video_model import KlyvaronVideoRuntime
from fabric.multimodal.voice_model import KlyvaronVoiceRuntime


def emit(record: dict) -> None:
    sys.stdout.write(json.dumps(record) + "\n")
    sys.stdout.flush()


def _detect_runtime_backends() -> dict:
    backends = {"cpu": {"available": True, "driver": platform.processor() or platform.machine(), "devices": 1}}
    for name in ("gpu", "rocm", "metal"):
        try:
            import jax
            devs = jax.devices(name)
            backends[name] = {"available": len(devs) > 0, "devices": len(devs)}
        except Exception as exc:
            backends[name] = {"available": False, "devices": 0, "reason": str(exc)}
    return {
        "cpu": backends["cpu"],
        "cuda": backends["gpu"],
        "rocm": backends["rocm"],
        "mps": backends["metal"],
    }


def _assert_backend_executable(backend: str) -> dict:
    probed = _detect_runtime_backends()
    if backend not in probed:
        raise ValueError(f"Unsupported execution backend '{backend}' (supported: cpu, cuda, rocm, mps)")
    entry = probed[backend]
    if not entry.get("available"):
        raise RuntimeError(
            f"Backend '{backend}' is not supported/available on this machine: {entry.get('reason', 'no compatible accelerator device detected')}"
        )
    return entry


def _is_multimodal_dir(path: Path) -> bool:
    manifest_file = path / "manifest.json"
    if not manifest_file.is_file():
        return False
    try:
        data = json.loads(manifest_file.read_text(encoding="utf-8"))
        return data.get("schema") == MULTIMODAL_FORMAT or data.get("format") == MULTIMODAL_ADAPTER_FORMAT
    except Exception:
        return False


def cmd_inspect(spec: dict) -> None:
    model_dir = Path(spec["modelDir"])
    if _is_multimodal_dir(model_dir):
        manifest, processor, params = load_multimodal_package(model_dir)
        adapter_info = None
        if spec.get("adapterDir"):
            _, adapter_manifest = apply_multimodal_adapter(params, Path(spec["adapterDir"]), manifest)
            adapter_info = {
                "id": adapter_manifest["id"],
                "version": adapter_manifest["version"],
                "sha256": adapter_manifest["weights"]["sha256"],
                "parameterCount": adapter_manifest["parameterCount"],
                "deltaL2Norm": adapter_manifest["deltaL2Norm"],
            }
        emit(
            {
                "type": "result",
                "ok": True,
                "model": {
                    "id": manifest["id"],
                    "version": manifest["version"],
                    "format": manifest["schema"],
                    "tier": manifest.get("tier"),
                    "modality": manifest["modality"],
                    "parameterCount": manifest["parameterCount"],
                    "architecture": manifest["architecture"],
                    "weightsSha256": manifest["weights"]["weightsSha256"],
                    "fileSha256": manifest["weights"]["sha256"],
                    "weightsBytes": manifest["weights"]["bytes"],
                    "processorKind": processor.get("kind"),
                    "processorSha256": manifest["processor"]["sha256"],
                    "supportedTasks": manifest.get("supportedTasks", []),
                    "unsupportedTasks": manifest.get("unsupportedTasks", []),
                    "metrics": manifest.get("metrics", {}),
                    "limitations": manifest.get("limitations", []),
                    "provenance": manifest.get("provenance", {}),
                    "adapter": adapter_info,
                },
            }
        )
        return

    model, tokenizer, manifest, base_snapshot = load_installed_klyvaron_model(model_dir)
    adapter_info = None
    if spec.get("adapterDir"):
        adapter, adapter_manifest = LoRAAdapter.load_and_verify(
            spec["adapterDir"],
            base_params=base_snapshot,
            config=model.config,
            expected_base_manifest=manifest,
        )
        adapter_info = {
            "id": adapter_manifest["id"],
            "version": adapter_manifest["version"],
            "sha256": adapter_manifest["weights"]["sha256"],
            "parameterCount": adapter.parameter_count,
            "deltaL2Norm": round(adapter.delta_l2_norm(), 6),
        }
    emit(
        {
            "type": "result",
            "ok": True,
            "model": {
                "id": manifest["id"],
                "version": manifest["version"],
                "format": manifest["format"],
                "tier": manifest.get("tier"),
                "modality": "chat",
                "instructionTuned": bool(manifest.get("instructionTuned", False)),
                "parameterCount": model.parameter_count,
                "architecture": manifest["architecture"],
                "weightsSha256": manifest["weights"]["sha256"],
                "weightsBytes": manifest["weights"]["bytes"],
                "tokenizerKind": manifest["tokenizer"]["kind"],
                "tokenizerDigest": manifest["tokenizer"]["digest"],
                "adapter": adapter_info,
            },
        }
    )


def cmd_validate(spec: dict) -> None:
    artifact_dir = Path(spec["artifactDir"])
    if _is_multimodal_dir(artifact_dir):
        manifest_data = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8"))
        if manifest_data.get("format") == MULTIMODAL_ADAPTER_FORMAT:
            if not spec.get("baseModelDir"):
                raise ValueError("baseModelDir is required to validate a multimodal adapter")
            base_manifest, _, base_params = load_multimodal_package(Path(spec["baseModelDir"]))
            merged, verified = apply_multimodal_adapter(base_params, artifact_dir, base_manifest)
            finite = all(bool(np.all(np.isfinite(v))) for v in merged.values())
            emit(
                {
                    "type": "result",
                    "ok": True,
                    "valid": True,
                    "kind": "multimodal_adapter",
                    "modality": verified["modality"],
                    "id": verified["id"],
                    "version": verified["version"],
                    "sha256": verified["weights"]["sha256"],
                    "bytes": verified["weights"]["bytes"],
                    "baseModelId": verified["baseModel"]["id"],
                    "baseWeightsSha256": verified["baseModel"]["weightsSha256"],
                    "parameterCount": verified["parameterCount"],
                    "deltaL2Norm": verified["deltaL2Norm"],
                    "finiteWeights": finite,
                }
            )
            return

        manifest, _, params = load_multimodal_package(artifact_dir)
        finite = all(bool(np.all(np.isfinite(v))) for v in params.values())
        emit(
            {
                "type": "result",
                "ok": True,
                "valid": True,
                "kind": "multimodal_checkpoint",
                "modality": manifest["modality"],
                "id": manifest["id"],
                "version": manifest["version"],
                "sha256": manifest["weights"]["sha256"],
                "weightsSha256": manifest["weights"]["weightsSha256"],
                "bytes": manifest["weights"]["bytes"],
                "parameterCount": manifest["parameterCount"],
                "finiteWeights": finite,
            }
        )
        return

    manifest_path = find_manifest_file(artifact_dir)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    ready = (artifact_dir / ".ready").is_file()
    if not ready:
        raise ValueError(f"artifact at {artifact_dir} is missing .ready marker")

    if manifest.get("format") == ADAPTER_FORMAT:
        if not spec.get("baseModelDir"):
            raise ValueError("baseModelDir is required to validate a LoRA adapter artifact")
        model, _, base_manifest, base_snapshot = load_installed_klyvaron_model(spec["baseModelDir"])
        adapter, verified = LoRAAdapter.load_and_verify(
            artifact_dir,
            base_params=base_snapshot,
            config=model.config,
            expected_base_manifest=base_manifest,
        )
        adapter.apply_to_model(model)
        probe = model.forward(
            np.zeros((1, 4), dtype="int64"),
            cache=False,
            **default_conditioning(model.config, 1, 4),
        )
        finite = bool(np.isfinite(probe).all())
        if not finite:
            raise ValueError("merged adapter + base forward pass produced non-finite logits")
        emit(
            {
                "type": "result",
                "ok": True,
                "valid": True,
                "kind": "lora_adapter",
                "id": verified["id"],
                "version": verified["version"],
                "sha256": verified["weights"]["sha256"],
                "bytes": verified["weights"]["bytes"],
                "baseModelId": verified["baseModel"]["id"],
                "baseWeightsSha256": verified["baseModel"]["weightsSha256"],
                "parameterCount": adapter.parameter_count,
                "deltaL2Norm": round(adapter.delta_l2_norm(), 6),
                "finiteProbeLogits": finite,
            }
        )
    else:
        model, _, verified, _ = load_installed_klyvaron_model(artifact_dir)
        probe = model.forward(
            np.zeros((1, 4), dtype="int64"),
            cache=False,
            **default_conditioning(model.config, 1, 4),
        )
        finite = bool(np.isfinite(probe).all())
        if not finite:
            raise ValueError("checkpoint forward pass produced non-finite logits")
        emit(
            {
                "type": "result",
                "ok": True,
                "valid": True,
                "kind": "model_checkpoint",
                "id": verified["id"],
                "version": verified["version"],
                "sha256": verified["weights"]["sha256"],
                "bytes": verified["weights"]["bytes"],
                "parameterCount": model.parameter_count,
                "finiteProbeLogits": finite,
            }
        )


def cmd_infer(spec: dict) -> None:
    model_dir = Path(spec["modelDir"])
    if _is_multimodal_dir(model_dir):
        manifest, processor, params = load_multimodal_package(model_dir)
        active_adapter = None
        if spec.get("adapterDir"):
            params, adapter_manifest = apply_multimodal_adapter(params, Path(spec["adapterDir"]), manifest)
            active_adapter = {"id": adapter_manifest["id"], "sha256": adapter_manifest["weights"]["sha256"]}

        modality = manifest["modality"]
        task = spec.get("task")
        t0 = time.perf_counter()

        if modality == "image":
            rt = KlyvaronImageRuntime(manifest, processor, params)
            task = task or "image.generate"
            seed_val = int(spec["seed"]) if spec.get("seed") is not None else 42
            if task == "image.generate":
                w, h = parse_size_spec(spec.get("size"), default_side=int(spec.get("width") or 256))
                if spec.get("width") and spec.get("height"):
                    w, h = int(spec["width"]), int(spec["height"])
                out = rt.generate(spec["prompt"], width=w, height=h, seed=seed_val)
                payload_b64 = base64.b64encode(out.pop("pngBytes")).decode("ascii")
                out["mediaBase64"] = payload_b64
            elif task == "image.edit":
                img_bytes = base64.b64decode(spec["imageBase64"])
                strength_val = float(spec["strength"]) if spec.get("strength") is not None else 0.72
                out = rt.edit(
                    img_bytes,
                    spec["prompt"],
                    strength=strength_val,
                    width=int(spec["width"]) if spec.get("width") else None,
                    height=int(spec["height"]) if spec.get("height") else None,
                    seed=seed_val,
                )
                out["mediaBase64"] = base64.b64encode(out.pop("pngBytes")).decode("ascii")
            elif task == "vision.understand":
                img_bytes = base64.b64decode(spec["imageBase64"])
                out = rt.understand(img_bytes, question=spec.get("prompt") or "")
            else:
                raise ValueError(f"Unsupported image task '{task}' (supported: {manifest['supportedTasks']})")

        elif modality == "video":
            rt = KlyvaronVideoRuntime(manifest, processor, params)
            task = task or "video.generate"
            seed_val = int(spec["seed"]) if spec.get("seed") is not None else 42
            if task == "video.generate":
                out = rt.generate(
                    spec["prompt"],
                    aspect_ratio=spec.get("aspectRatio") or "16:9",
                    resolution=spec.get("resolution") or "720p",
                    duration_ms=int(spec["durationMs"]) if spec.get("durationMs") is not None else 2000,
                    seed=seed_val,
                )
                out["mediaBase64"] = base64.b64encode(out.pop("mp4Bytes")).decode("ascii")
            elif task == "video.understand":
                vid_bytes = base64.b64decode(spec["videoBase64"])
                out = rt.understand(vid_bytes, question=spec.get("prompt") or "")
            else:
                raise ValueError(f"Unsupported video task '{task}' (supported: {manifest['supportedTasks']})")

        elif modality == "voice":
            rt = KlyvaronVoiceRuntime(manifest, processor, params)
            task = task or ("speech.transcribe" if spec.get("audioBase64") else "speech.synthesize")
            if task == "speech.synthesize":
                out = rt.synthesize(spec["prompt"])
                out["mediaBase64"] = base64.b64encode(out.pop("wavBytes")).decode("ascii")
            elif task == "speech.transcribe":
                wav_bytes = base64.b64decode(spec["audioBase64"])
                out = rt.transcribe(wav_bytes)
            else:
                raise ValueError(f"Unsupported voice task '{task}' (supported: {manifest['supportedTasks']})")
        else:
            raise ValueError(f"Unknown multimodal modality '{modality}'")

        latency_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        emit(
            {
                "type": "result",
                "ok": True,
                "modelId": manifest["id"],
                "version": manifest["version"],
                "modality": modality,
                "task": task,
                "weightsSha256": manifest["weights"]["weightsSha256"],
                "fileSha256": manifest["weights"]["sha256"],
                "activeAdapter": active_adapter,
                "output": out,
                "latencyMs": latency_ms,
                "peakRssBytes": peak_rss_bytes(),
            }
        )
        return

    model, tokenizer, manifest, base_snapshot = load_installed_klyvaron_model(model_dir)
    active_adapter = None
    if spec.get("adapterDir"):
        adapter, adapter_manifest = LoRAAdapter.load_and_verify(
            spec["adapterDir"],
            base_params=base_snapshot,
            config=model.config,
            expected_base_manifest=manifest,
        )
        adapter.apply_to_model(model)
        active_adapter = {
            "id": adapter_manifest["id"],
            "sha256": adapter_manifest["weights"]["sha256"],
        }

    instruction_tuned = bool(manifest.get("instructionTuned", False))
    generation = greedy_generate_reply(
        model,
        tokenizer,
        spec["prompt"],
        max_new_tokens=int(spec.get("maxNewTokens", 20)),
        instruction_tuned=instruction_tuned,
    )
    target_eval = None
    if spec.get("target") is not None:
        x, y, m = encode_input_target_example(
            tokenizer,
            {"input": spec["prompt"], "target": spec["target"]},
            seq_len=model.config.seq_len,
            instruction_tuned=instruction_tuned,
        )
        nll = evaluate_batches_loss(model, [(x[None, :], y[None, :], m[None, :])])
        target_eval = {"targetNll": round(nll, 6)}

    emit(
        {
            "type": "result",
            "ok": True,
            "modelId": manifest["id"],
            "version": manifest["version"],
            "modality": "chat",
            "weightsSha256": manifest["weights"]["sha256"],
            "activeAdapter": active_adapter,
            "generation": generation,
            "targetEvaluation": target_eval,
            "peakRssBytes": peak_rss_bytes(),
        }
    )


def cmd_qualify(spec: dict) -> None:
    backend = spec.get("backend", "cpu")
    backend_info = _assert_backend_executable(backend)
    model_dir = Path(spec["modelDir"])
    rss_before = peak_rss_bytes()
    t_init0 = time.perf_counter()

    if _is_multimodal_dir(model_dir):
        manifest, processor, params = load_multimodal_package(model_dir)
        init_ms = round((time.perf_counter() - t_init0) * 1000.0, 2)
        modality = manifest["modality"]
        t_inf0 = time.perf_counter()
        if modality == "image":
            rt = KlyvaronImageRuntime(manifest, processor, params)
            gen = rt.generate("warm crimson sunset horizon over calm water", width=128, height=128, seed=7)
            und = rt.understand(gen["pngBytes"])
            out_bytes = gen["pngBytes"]
            summary = {"generatedBytes": len(out_bytes), "detectedScene": und["scene"], "confidence": und["confidence"]}
        elif modality == "video":
            rt = KlyvaronVideoRuntime(manifest, processor, params)
            gen = rt.generate("smooth camera pan right motion across ocean tide waves", aspect_ratio="16:9", resolution="720p", duration_ms=2000, seed=7)
            und = rt.understand(gen["mp4Bytes"])
            out_bytes = gen["mp4Bytes"]
            summary = {"generatedBytes": len(out_bytes), "durationSeconds": gen["durationSeconds"], "detectedMotion": und["motion"], "motionEnergy": gen["motionEnergy"]}
        elif modality == "voice":
            rt = KlyvaronVoiceRuntime(manifest, processor, params)
            syn = rt.synthesize("system ready")
            rec = rt.transcribe(syn["wavBytes"])
            out_bytes = syn["wavBytes"]
            summary = {"generatedBytes": len(out_bytes), "durationSeconds": syn["durationSeconds"], "transcribedText": rec["text"]}
        else:
            raise ValueError(f"Unsupported multimodal modality: {modality}")

        latency_ms = round((time.perf_counter() - t_inf0) * 1000.0, 2)
        rss_after = peak_rss_bytes()
        emit(
            {
                "type": "result",
                "ok": True,
                "qualified": True,
                "backend": backend,
                "backendInfo": backend_info,
                "modelId": manifest["id"],
                "modelVersion": manifest["version"],
                "modality": modality,
                "artifactSha256": manifest["weights"]["sha256"],
                "weightsSha256": manifest["weights"]["weightsSha256"],
                "runtimeVersion": manifest.get("runtimeVersion", "klyvaron-multimodal-runtime/1.0"),
                "initMs": init_ms,
                "latencyMs": latency_ms,
                "rssBeforeMb": round(rss_before / (1024 * 1024), 2),
                "rssAfterMb": round(rss_after / (1024 * 1024), 2),
                "outputSha256": hashlib.sha256(out_bytes).hexdigest(),
                "summary": summary,
            }
        )
        return

    model, tokenizer, manifest, _ = load_installed_klyvaron_model(model_dir)
    init_ms = round((time.perf_counter() - t_init0) * 1000.0, 2)
    t_inf0 = time.perf_counter()
    gen = greedy_generate_reply(
        model,
        tokenizer,
        "Summarize Klyvaron architecture verification.",
        max_new_tokens=6,
        instruction_tuned=bool(manifest.get("instructionTuned", False)),
    )
    latency_ms = round((time.perf_counter() - t_inf0) * 1000.0, 2)
    rss_after = peak_rss_bytes()
    sample_txt = str(gen.get("reply", gen.get("text", "")))
    out_bytes = sample_txt.encode("utf-8")
    emit(
        {
            "type": "result",
            "ok": True,
            "qualified": True,
            "backend": backend,
            "backendInfo": backend_info,
            "modelId": manifest["id"],
            "modelVersion": manifest["version"],
            "modality": "chat",
            "artifactSha256": manifest["weights"]["sha256"],
            "weightsSha256": manifest["weights"]["sha256"],
            "runtimeVersion": f"numpy/{np.__version__}",
            "initMs": init_ms,
            "latencyMs": latency_ms,
            "rssBeforeMb": round(rss_before / (1024 * 1024), 2),
            "rssAfterMb": round(rss_after / (1024 * 1024), 2),
            "outputSha256": hashlib.sha256(out_bytes).hexdigest(),
            "summary": {"generatedTokens": int(gen.get("completionTokens", gen.get("tokensGenerated", 0))), "sample": sample_txt[:80]},
        }
    )


def cmd_train(spec: dict) -> None:
    cancelled = {"flag": False}

    def _handle_sig(_signum, _frame):
        cancelled["flag"] = True

    signal.signal(signal.SIGTERM, _handle_sig)
    signal.signal(signal.SIGINT, _handle_sig)

    cancel_file = Path(spec["cancelFlagPath"]) if spec.get("cancelFlagPath") else None

    def check_cancelled() -> bool:
        return cancelled["flag"] or bool(cancel_file and cancel_file.exists())

    if spec.get("modality") in ("image", "video", "voice"):
        result = run_multimodal_training_job(
            spec,
            emit_progress=lambda p: emit({"type": "progress", **p}),
            should_cancel=check_cancelled,
        )
        emit({"type": "result", "ok": True, **result})
        return

    result = run_worker_training_job(
        spec,
        emit_progress=lambda p: emit({"type": "progress", **p}),
        should_cancel=check_cancelled,
    )
    emit({"type": "result", "ok": True, **result})


def main() -> int:
    if len(sys.argv) != 3:
        emit({"type": "error", "code": "invalid_cli_usage", "message": "Expected: worker_exec.py <op> <spec.json>"})
        return 2
    op, spec_path = sys.argv[1], Path(sys.argv[2])
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        if op == "inspect":
            cmd_inspect(spec)
        elif op == "validate":
            cmd_validate(spec)
        elif op == "qualify":
            cmd_qualify(spec)
        elif op == "infer":
            cmd_infer(spec)
        elif op == "train":
            cmd_train(spec)
        else:
            emit({"type": "error", "code": "unknown_worker_op", "message": f"Unknown operation {op!r}"})
            return 2
        return 0
    except TrainingCancelledError as exc:
        emit({"type": "error", "code": "job_cancelled", "message": str(exc)})
        return 130
    except TrainingLimitExceededError as exc:
        emit({"type": "error", "code": "exceeded_interactive_120s_limit", "message": str(exc)})
        return 124
    except Exception as exc:
        emit({"type": "error", "code": "worker_execution_failed", "message": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

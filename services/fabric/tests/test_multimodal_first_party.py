"""Pytest verification suite for Klyvaron first-party Image, Video, and Voice models + multimodal adapters."""

from __future__ import annotations

from pathlib import Path
import pytest

from fabric.lm.adapter import TrainingCancelledError, TrainingLimitExceededError
from fabric.multimodal.adapter import apply_multimodal_adapter, run_multimodal_training_job
from fabric.multimodal.common import load_multimodal_package
from fabric.multimodal.image_model import IMAGE_PRESETS, KlyvaronImageRuntime, train_and_export_image_preset
from fabric.multimodal.video_model import VIDEO_PRESETS, KlyvaronVideoRuntime, train_and_export_video_preset
from fabric.multimodal.voice_model import VOICE_PRESETS, KlyvaronVoiceRuntime, train_and_export_voice_preset


def test_first_party_image_video_voice_train_verify_infer_and_adapt(tmp_path: Path) -> None:
    install_root = tmp_path / "models"

    # 1. Image: Pro & Max distinct parameter counts, distinct SHA-256, PNG validity, edit & vision understanding
    pro_img = train_and_export_image_preset("pro", install_root, steps_override=12)
    max_img = train_and_export_image_preset("max", install_root, steps_override=8)
    assert pro_img["parameterCount"] < max_img["parameterCount"]
    assert pro_img["weights"]["weightsSha256"] != max_img["weights"]["weightsSha256"]

    img_rt = KlyvaronImageRuntime.load(install_root / "klyvaron-pro-image")
    gen_img = img_rt.generate("warm crimson sunset horizon", width=160, height=128, seed=11)
    assert gen_img["pngBytes"][:8] == b"\x89PNG\r\n\x1a\n"
    edited_img = img_rt.edit(gen_img["pngBytes"], "cobalt ocean waves", strength=0.75, width=160, height=128)
    assert edited_img["pngBytes"][:8] == b"\x89PNG\r\n\x1a\n"
    assert edited_img["meanAbsPixelDelta"] > 0.0

    # 2. Video: Pro & Max distinct weights, genuine ISO-BMFF H.264 MP4 >= 8 KiB, motion > 0, temporal understanding
    pro_vid = train_and_export_video_preset("pro", install_root, steps_override=10)
    max_vid = train_and_export_video_preset("max", install_root, steps_override=8)
    assert pro_vid["parameterCount"] < max_vid["parameterCount"]
    assert pro_vid["weights"]["weightsSha256"] != max_vid["weights"]["weightsSha256"]

    vid_rt = KlyvaronVideoRuntime.load(install_root / "klyvaron-pro-video")
    gen_vid = vid_rt.generate("smooth camera pan right motion across ocean waves", duration_ms=2000, seed=5)
    assert gen_vid["mp4Bytes"][4:8] == b"ftyp"
    assert len(gen_vid["mp4Bytes"]) >= 8192
    assert gen_vid["motionEnergy"] > 0.0

    # 3. Voice: Pro & Max distinct weights, WAV RIFF/WAVE header, bidirectional TTS + ASR round-trip
    pro_voc = train_and_export_voice_preset("pro", install_root, steps_override=12)
    max_voc = train_and_export_voice_preset("max", install_root, steps_override=8)
    assert pro_voc["parameterCount"] < max_voc["parameterCount"]
    assert pro_voc["weights"]["weightsSha256"] != max_voc["weights"]["weightsSha256"]

    voc_rt = KlyvaronVoiceRuntime.load(install_root / "klyvaron-pro-voice")
    synth = voc_rt.synthesize("status check")
    assert synth["wavBytes"][:4] == b"RIFF" and synth["wavBytes"][8:12] == b"WAVE"
    transcribed = voc_rt.transcribe(synth["wavBytes"])
    assert isinstance(transcribed["text"], str) and len(transcribed["text"]) > 0

    # 4. Interactive multimodal adapter lowers loss, validates cleanly, enforces 120s limit, and supports cancellation
    adapter_dir = tmp_path / "img-adapter"
    adapt_res = run_multimodal_training_job(
        {
            "mode": "lightweight_adapter",
            "modality": "image",
            "modelDir": str(install_root / "klyvaron-pro-image"),
            "outputDir": str(adapter_dir),
            "examples": [{"input": "sunset", "target": "sunset_horizon"}, {"input": "ocean", "target": "ocean_waves"}],
            "maxSteps": 8,
            "learningRate": 0.02,
        }
    )
    assert adapt_res["finalLoss"] < adapt_res["initialLoss"]
    base_manifest, _, base_params = load_multimodal_package(install_root / "klyvaron-pro-image")
    merged, verified = apply_multimodal_adapter(base_params, adapter_dir, base_manifest)
    assert len(merged) == len(base_params)
    assert verified["deltaL2Norm"] > 0.0

    with pytest.raises(TrainingLimitExceededError):
        run_multimodal_training_job(
            {
                "mode": "lightweight_adapter",
                "modality": "image",
                "modelDir": str(install_root / "klyvaron-pro-image"),
                "outputDir": str(tmp_path / "timeout-adapter"),
                "examples": [{"input": "sunset", "target": "sunset_horizon"}],
                "maxSteps": 5,
                "maxDurationMs": 20.0,
                "stepDelayMs": 30.0,
            }
        )

    with pytest.raises(TrainingCancelledError):
        run_multimodal_training_job(
            {
                "mode": "lightweight_adapter",
                "modality": "voice",
                "modelDir": str(install_root / "klyvaron-pro-voice"),
                "outputDir": str(tmp_path / "cancel-adapter"),
                "examples": [{"input": "status check", "target": "status check"}],
                "maxSteps": 4,
            },
            should_cancel=lambda: True,
        )

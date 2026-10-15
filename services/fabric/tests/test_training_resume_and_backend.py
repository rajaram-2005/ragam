"""Resume from an attached output, and the torch-free parts of the HF backend.

The real backend needs torch, which CI does not install. What can be tested without it is
tested here: the Hub pin and licence checks (with an injected fake Hub), the batch order
that makes resume deterministic, and the prompt masking that keeps loss on the answer only.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from fabric.training import hf_peft, synthetic
from fabric.training.checkpoint import CheckpointStore, import_latest

CFG = "c" * 64
OTHER = "d" * 64
PINNED = "7ae557604adf67be50417f59c2c2f167def9a775"


# ----------------------------------------------------------------- resume import

def test_the_newest_verified_checkpoint_is_imported_into_an_empty_store(tmp_path):
    source = CheckpointStore(tmp_path / "attached")
    source.save(50, {"a.bin": b"one"}, config_digest=CFG, meta={"step": 50})
    source.save(100, {"a.bin": b"two"}, config_digest=CFG, meta={"step": 100})
    dest = CheckpointStore(tmp_path / "working")
    imported = import_latest(source, dest, CFG)
    assert imported is not None and imported.step == 100
    assert dest.load_latest(CFG).files == {"a.bin": b"two"}
    assert source.load_latest(CFG).step == 100          # the source is only read


def test_nothing_is_imported_when_the_local_store_is_already_as_new(tmp_path):
    source = CheckpointStore(tmp_path / "attached")
    source.save(50, {"a.bin": b"old"}, config_digest=CFG)
    dest = CheckpointStore(tmp_path / "working")
    dest.save(100, {"a.bin": b"local"}, config_digest=CFG)
    kept = import_latest(source, dest, CFG)
    assert kept.step == 100 and kept.files == {"a.bin": b"local"}
    assert dest.steps() == [100], "an older attached checkpoint was copied into the working store"


def test_a_checkpoint_from_another_configuration_is_never_imported(tmp_path):
    from fabric.training.checkpoint import ResumeMismatch

    source = CheckpointStore(tmp_path / "attached")
    source.save(50, {"a.bin": b"x"}, config_digest=OTHER)
    dest = CheckpointStore(tmp_path / "working")
    with pytest.raises(ResumeMismatch):
        import_latest(source, dest, CFG)
    assert dest.steps() == []


def test_an_empty_or_missing_source_imports_nothing(tmp_path):
    assert import_latest(CheckpointStore(tmp_path / "nothing-here"), CheckpointStore(tmp_path / "w"), CFG) is None


# ----------------------------------------------------------------- Hub gate, with a fake Hub

LICENCE_APACHE = "Apache License\n                           Version 2.0, January 2004\n"
LICENCE_MIT = "MIT License\n\nCopyright (c) 2026 someone\n"


class FakeHub:
    def __init__(self, tmp_path: Path, *, resolved=PINNED, declared="apache-2.0", licence=LICENCE_APACHE,
                 weights=b"weights-bytes", hub_sha=None):
        self.tmp = tmp_path
        self.resolved = resolved
        self.declared = declared
        self.licence = licence
        self.weights = weights
        self.hub_sha = hub_sha if hub_sha is not None else hashlib.sha256(weights).hexdigest()

    def model_info(self, repo, revision=None, files_metadata=False):
        assert files_metadata is True
        return SimpleNamespace(
            sha=self.resolved,
            card_data=SimpleNamespace(license=self.declared),
            siblings=[SimpleNamespace(rfilename="config.json", lfs=None),
                      SimpleNamespace(rfilename="model.safetensors",
                                      lfs=SimpleNamespace(sha256=self.hub_sha))],
        )

    def hf_hub_download(self, repo, filename, revision=None):
        assert filename == "LICENSE" and revision == PINNED
        path = self.tmp / "LICENSE"
        path.write_text(self.licence, encoding="utf-8")
        return str(path)

    def snapshot_download(self, repo, revision=None):
        assert revision == PINNED
        local = self.tmp / "snapshot"
        local.mkdir(exist_ok=True)
        (local / "model.safetensors").write_bytes(self.weights)
        return str(local)


def job_for_base() -> dict:
    template = Path(__file__).resolve().parent.parent / "remote" / "jobs" / "klyvaron-chat-lora-experiment.json"
    return json.loads(template.read_text(encoding="utf-8"))


def test_the_hub_gate_passes_when_everything_matches(tmp_path):
    result = hf_peft.HFPeftBackend(hub=FakeHub(tmp_path)).verify_model(job_for_base())
    assert result["problems"] == []
    assert result["revision_matches"] and result["licence_text_ok"] and result["weights_match"]


def test_the_hub_gate_refuses_a_revision_it_did_not_resolve(tmp_path):
    result = hf_peft.HFPeftBackend(hub=FakeHub(tmp_path, resolved="f" * 40)).verify_model(job_for_base())
    assert any("resolved revision" in p for p in result["problems"])


def test_the_hub_gate_refuses_a_non_apache_licence_text(tmp_path):
    result = hf_peft.HFPeftBackend(hub=FakeHub(tmp_path, licence=LICENCE_MIT)).verify_model(job_for_base())
    assert any("not Apache License 2.0" in p for p in result["problems"])


def test_the_hub_gate_refuses_a_declared_licence_that_differs(tmp_path):
    result = hf_peft.HFPeftBackend(hub=FakeHub(tmp_path, declared="mit")).verify_model(job_for_base())
    assert any("declares licence" in p for p in result["problems"])


def test_the_hub_gate_refuses_weights_that_do_not_match_the_hub(tmp_path):
    result = hf_peft.HFPeftBackend(hub=FakeHub(tmp_path, weights=b"tampered",
                                               hub_sha="0" * 64)).verify_model(job_for_base())
    assert any("does not match the Hub" in p for p in result["problems"])


def test_the_hub_gate_refuses_when_the_hub_gives_no_hash(tmp_path):
    fake = FakeHub(tmp_path)
    fake.model_info = lambda repo, revision=None, files_metadata=False: SimpleNamespace(
        sha=PINNED, card_data=SimpleNamespace(license="apache-2.0"),
        siblings=[SimpleNamespace(rfilename="model.safetensors", lfs=None)])
    result = hf_peft.HFPeftBackend(hub=fake).verify_model(job_for_base())
    assert any("did not report a SHA-256" in p for p in result["problems"])


def test_the_environment_is_safe_to_ask_without_torch():
    import importlib.util

    info = hf_peft.HFPeftBackend().environment()
    assert "packages" in info and "gpu" in info
    if importlib.util.find_spec("torch") is None:
        assert info["gpu"] is None
        assert any("torch is not importable" in p for p in info["problems"])


def test_the_prompt_format_is_the_training_format():
    text = hf_peft.HFPeftBackend.prompt_text("What is 2 plus 2?")
    assert text == f"{synthetic.INSTRUCTION_MARKER}What is 2 plus 2?\n\n{synthetic.RESPONSE_MARKER}"


def test_an_adapter_argument_is_refused_by_the_base_inference_path():
    with pytest.raises(ValueError):
        hf_peft.HFPeftBackend().infer("hi", adapter_dir="/somewhere")


# ----------------------------------------------------------------- batching without torch

def _trainer_without_torch(job: dict, rows: int):
    trainer = object.__new__(hf_peft.HFLoraTrainer)
    trainer._job = job
    trainer._rows = {"train": [{"text": str(i)} for i in range(rows)]}
    trainer._orders = {}
    return trainer


def test_a_batch_depends_on_the_step_alone_so_resume_follows_the_same_path():
    job = job_for_base()
    first = _trainer_without_torch(job, 2000)
    second = _trainer_without_torch(job, 2000)
    for step in (0, 1, 17, 250, 999):
        assert first._indices(step) == second._indices(step)
    # Reading step 999 first must not change what step 0 gives.
    assert _trainer_without_torch(job, 2000)._indices(0) == first._indices(0)


def test_one_epoch_visits_every_row_exactly_once():
    job = job_for_base()
    rows = 2000
    batch = job["training"]["batchSize"]
    trainer = _trainer_without_torch(job, rows)
    seen = []
    for step in range(rows // batch):
        seen.extend(trainer._indices(step))
    assert sorted(seen) == list(range(rows))


def test_the_loss_is_taken_on_the_answer_only_not_the_prompt():
    job = job_for_base()
    job["training"]["seqLen"] = 512

    class CharTokenizer:
        def __call__(self, text, add_special_tokens=False, truncation=False, max_length=None):
            ids = [ord(c) for c in text]
            return {"input_ids": ids[:max_length] if truncation and max_length else ids}

    trainer = _trainer_without_torch(job, 1)
    trainer._tokenizer = CharTokenizer()
    row = {"text": synthetic.INSTRUCTION_MARKER + "Q?\n\n" + synthetic.RESPONSE_MARKER + "A!"}
    ids, labels = trainer._encode(row)
    cut = row["text"].index(synthetic.RESPONSE_MARKER) + len(synthetic.RESPONSE_MARKER)
    prompt_len = cut
    assert labels[:prompt_len] == [-100] * prompt_len
    assert labels[prompt_len:] == ids[prompt_len:]
    assert labels[prompt_len:] == [ord(c) for c in "A!"]

"""Hugging Face Transformers + PEFT backend for the LoRA smoke run.

This is the only module in fabric that needs torch, transformers and peft, and it
imports them lazily. Importing this file on a machine without them is safe. Everything
that needs them returns a problem, or raises, so the smoke ledger records a FAILED stage
instead of crashing.

Status: written against the documented APIs of the versions pinned in the notebook
(see ``remote/build_notebook.py``). It has NOT been executed on a GPU. The first real
run on Kaggle is the first test of it. Everything that can be checked without torch
(the Hub pin, the licence text, the weight hash, the data order, the prompt format) is
checked by ``tests/test_training_resume_and_backend.py`` with an injected fake Hub.

Design choices, and why:

* float32 weights. A 0.5B model fits in fp32 on a 16 GB GPU, and fp16/bf16 training has
  failure modes (overflow, unsupported bf16 on some GPUs) that would be hard to tell
  apart from a bad pipeline.
* Batches come from ``step`` alone (a seeded shuffle per epoch), as the runner requires.
* The loss is taken on the response tokens only. The prompt is masked out.
"""

from __future__ import annotations

import hashlib
import io
import json
import platform
import random
import shutil
import sys
from importlib import metadata
from pathlib import Path
from typing import Any, Mapping

from fabric.training import synthetic

BASE_META = "adapter-meta.json"
KAGGLE_WORKING = Path("/kaggle/working")
_PACKAGES = ("torch", "transformers", "peft", "accelerate", "huggingface_hub", "safetensors")


def _version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def _attr(obj: Any, name: str) -> Any:
    value = getattr(obj, name, None)
    if value is None and isinstance(obj, Mapping):
        value = obj.get(name)
    return value


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


class HFPeftBackend:
    """The backend the smoke ledger drives. Methods: environment, verify_model, trainer,
    infer, reload."""

    def __init__(self, *, hub: Any = None, work_dir: str | Path | None = None):
        self._hub = hub
        self._work = Path(work_dir) if work_dir else None
        self._job: Mapping | None = None
        self._local: Path | None = None
        self._tokenizer = None
        self._base_model = None

    # ------------------------------------------------------------------ hub
    @property
    def hub(self) -> Any:
        if self._hub is None:
            import huggingface_hub

            self._hub = huggingface_hub
        return self._hub

    def environment(self) -> dict:
        info: dict = {"python": sys.version.split()[0], "platform": platform.platform(), "problems": [],
                      "gpu": None, "packages": {name: _version(name) for name in _PACKAGES}}
        disk_root = KAGGLE_WORKING if KAGGLE_WORKING.exists() else Path.cwd()
        info["disk_free_gb"] = round(shutil.disk_usage(disk_root).free / 1024**3, 2)
        info["disk_root"] = str(disk_root)
        try:
            import torch
        except Exception as error:  # noqa: BLE001
            info["problems"].append(f"torch is not importable: {type(error).__name__}: {error}")
            return info
        info["torch"] = torch.__version__
        info["cuda"] = torch.version.cuda
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            info["gpu"] = props.name
            info["gpu_memory_gb"] = round(props.total_memory / 1024**3, 2)
            info["gpu_capability"] = f"{props.major}.{props.minor}"
        return info

    def verify_model(self, job: Mapping) -> dict:
        """Check the pinned revision, its licence text, and its weights against the Hub.

        Downloads the snapshot at the pinned revision. Every check is recorded, so a
        failure names the check that failed.
        """
        self._job = job
        base = job["base"]
        repo, revision = base["id"], base["revision"]
        problems: list[str] = []
        result: dict = {"repo": repo, "pinned_revision": revision, "problems": problems}

        info = self.hub.model_info(repo, revision=revision, files_metadata=True)
        resolved = _attr(info, "sha")
        result["resolved_revision"] = resolved
        result["revision_matches"] = resolved == revision
        if resolved != revision:
            problems.append(f"the Hub resolved revision {resolved!r}, not the pinned {revision!r}")

        card = _attr(info, "card_data")
        declared = _attr(card, "license") if card is not None else None
        result["declared_licence"] = declared
        result["licence_declared_matches"] = isinstance(declared, str) and declared.lower() == base["licence"].lower()
        if not result["licence_declared_matches"]:
            problems.append(f"the model card declares licence {declared!r}, not {base['licence']!r}")

        licence_path = Path(self.hub.hf_hub_download(repo, "LICENSE", revision=revision))
        licence_text = licence_path.read_text(encoding="utf-8", errors="replace")
        licence_ok = "Apache License" in licence_text and "Version 2.0" in licence_text
        result["licence_text_ok"] = licence_ok
        if base["licence"] == "Apache-2.0" and not licence_ok:
            problems.append("the LICENSE file at the pinned revision is not Apache License 2.0")

        hub_sha = None
        for sibling in _attr(info, "siblings") or []:
            if _attr(sibling, "rfilename") == "model.safetensors":
                lfs = _attr(sibling, "lfs")
                hub_sha = _attr(lfs, "sha256") if lfs is not None else None
        if not isinstance(hub_sha, str):
            problems.append("the Hub did not report a SHA-256 for model.safetensors")

        local = Path(self.hub.snapshot_download(repo, revision=revision))
        self._local = local
        weights = local / "model.safetensors"
        local_sha = _sha256_file(weights) if weights.is_file() else None
        result["weights_sha256"] = local_sha
        result["hub_weights_sha256"] = hub_sha
        result["weights_match"] = local_sha is not None and local_sha == hub_sha
        if not result["weights_match"]:
            problems.append("the downloaded model.safetensors does not match the Hub's SHA-256")
        result["local_dir"] = str(local)
        return result

    # ------------------------------------------------------------- loading
    def _require_base(self) -> Path:
        if self._local is None or self._job is None:
            raise RuntimeError("verify_model must run before the model is loaded")
        return self._local

    def _device(self):
        import torch

        return torch.device("cuda" if torch.cuda.is_available() else "cpu")

    def tokenizer(self):
        if self._tokenizer is None:
            from transformers import AutoTokenizer

            self._tokenizer = AutoTokenizer.from_pretrained(self._require_base())
        return self._tokenizer

    def _base(self):
        if self._base_model is None:
            self._base_model = self._load_base()
        return self._base_model

    def _load_base(self):
        import torch
        from transformers import AutoModelForCausalLM

        model = AutoModelForCausalLM.from_pretrained(self._require_base(), dtype=torch.float32)
        return model.to(self._device())

    # ------------------------------------------------------------ training
    def trainer(self, job: Mapping, dataset_dir: str | Path) -> "HFLoraTrainer":
        self._require_base()
        return HFLoraTrainer(self, job, Path(dataset_dir))

    # ----------------------------------------------------------- inference
    @staticmethod
    def prompt_text(prompt: str) -> str:
        return f"{synthetic.INSTRUCTION_MARKER}{prompt}\n\n{synthetic.RESPONSE_MARKER}"

    def _generate(self, model, prompt: str) -> str:
        import torch

        tokenizer = self.tokenizer()
        encoded = tokenizer(self.prompt_text(prompt), return_tensors="pt", add_special_tokens=False)
        encoded = {key: value.to(self._device()) for key, value in encoded.items()}
        with torch.no_grad():
            out = model.generate(**encoded, max_new_tokens=32, do_sample=False,
                                 pad_token_id=tokenizer.pad_token_id)
        text = tokenizer.decode(out[0][encoded["input_ids"].shape[1]:], skip_special_tokens=True)
        return text.split(synthetic.INSTRUCTION_MARKER)[0].strip()

    def infer(self, prompt: str, adapter_dir: str | Path | None = None) -> str:
        """Greedy output of the untrained base on ``prompt``. ``adapter_dir`` must be None here."""
        if adapter_dir is not None:
            raise ValueError("infer runs the untrained base; use reload for an adapter")
        model = self._base()
        model.eval()
        return self._generate(model, prompt)

    def reload(self, adapter_dir: str | Path, prompt: str) -> dict:
        """Load the base from scratch, attach the saved adapter, and generate and check logits.

        A new model object is built, so nothing from training is reused. The adapter's
        recorded base revision must equal the pinned one.
        """
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM

        adapter = Path(adapter_dir)
        problems: list[str] = []
        meta_path = adapter / BASE_META
        meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
        if meta.get("baseRevision") != self._job["base"]["revision"]:
            problems.append(f"adapter was trained on base revision {meta.get('baseRevision')!r}, "
                            f"not the pinned {self._job['base']['revision']!r}")
        base = AutoModelForCausalLM.from_pretrained(self._require_base(), dtype=torch.float32)
        model = PeftModel.from_pretrained(base, adapter).to(self._device())
        model.eval()
        tokenizer = self.tokenizer()
        ids = tokenizer(self.prompt_text(prompt), return_tensors="pt", add_special_tokens=False)["input_ids"]
        with torch.no_grad():
            logits = model(input_ids=ids.to(self._device())).logits
            finite = bool(torch.isfinite(logits).all().item())
        text = self._generate(model, prompt)
        names = sorted(p.name for p in adapter.iterdir()) if adapter.is_dir() else []
        del model, base
        if self._device().type == "cuda":
            torch.cuda.empty_cache()
        return {"text": text, "finite": finite, "adapter_files": names, "problems": problems}


class HFLoraTrainer:
    """Implements the runner's Trainer protocol with a LoRA adapter on the base model."""

    def __init__(self, backend: HFPeftBackend, job: Mapping, dataset_dir: Path):
        import torch
        from peft import LoraConfig, get_peft_model
        from transformers import AutoModelForCausalLM

        self._torch = torch
        self._backend = backend
        self._job = job
        self._device = backend._device()
        self._tokenizer = backend.tokenizer()
        self._pad = self._tokenizer.pad_token_id
        if self._pad is None:
            raise RuntimeError("the tokenizer has no pad token; the smoke run cannot batch")

        training = job["training"]
        base = AutoModelForCausalLM.from_pretrained(backend._require_base(), dtype=torch.float32)
        config = LoraConfig(r=training["rank"], lora_alpha=training["alpha"], lora_dropout=training["dropout"],
                            target_modules=list(training["targetModules"]), bias="none", task_type="CAUSAL_LM")
        self._model = get_peft_model(base, config).to(self._device)
        trainable = [p for p in self._model.parameters() if p.requires_grad]
        if not trainable:
            raise RuntimeError("no trainable LoRA parameters; check training.targetModules")
        self._optimizer = torch.optim.AdamW(trainable, lr=training["learningRate"])
        self._trainable_count = sum(p.numel() for p in trainable)

        self._rows = {
            "train": self._load(dataset_dir, job["dataset"]["train"]["file"]),
            "validation": self._load(dataset_dir, job["dataset"]["validation"]["file"]),
        }
        for item in job["dataset"].get("regression", []):
            self._rows[item["name"]] = self._load(dataset_dir, item["file"])
        self._orders: dict[int, list[int]] = {}

    @staticmethod
    def _load(dataset_dir: Path, name: str) -> list[dict]:
        rows = []
        for line in (dataset_dir / name).read_text(encoding="ascii").splitlines():
            rows.append(json.loads(line))
        return rows

    # -- batching ---------------------------------------------------------
    def _encode(self, row: Mapping) -> tuple[list[int], list[int]]:
        text = row["text"]
        cut = text.index(synthetic.RESPONSE_MARKER) + len(synthetic.RESPONSE_MARKER)
        seq = self._job["training"]["seqLen"]
        ids = self._tokenizer(text, add_special_tokens=False, truncation=True, max_length=seq)["input_ids"]
        prompt_len = len(self._tokenizer(text[:cut], add_special_tokens=False)["input_ids"])
        labels = [-100] * min(prompt_len, len(ids)) + ids[prompt_len:]
        return ids, labels

    def _collate(self, rows: list[Mapping]):
        torch = self._torch
        encoded = [self._encode(row) for row in rows]
        width = max(len(ids) for ids, _ in encoded)
        input_ids = torch.full((len(rows), width), self._pad, dtype=torch.long)
        attention = torch.zeros((len(rows), width), dtype=torch.long)
        labels = torch.full((len(rows), width), -100, dtype=torch.long)
        for i, (ids, lab) in enumerate(encoded):
            input_ids[i, :len(ids)] = torch.tensor(ids)
            attention[i, :len(ids)] = 1
            labels[i, :len(lab)] = torch.tensor(lab)
        return input_ids.to(self._device), attention.to(self._device), labels.to(self._device)

    def _indices(self, step: int) -> list[int]:
        """Batch indices from ``step`` alone: a seeded shuffle per epoch, read by position."""
        rows = len(self._rows["train"])
        batch = self._job["training"]["batchSize"]
        seed = self._job["training"]["seed"]
        epoch = (step * batch) // rows
        if epoch not in self._orders:
            order = list(range(rows))
            random.Random(f"{seed}:epoch:{epoch}").shuffle(order)
            self._orders = {epoch: order}  # keep only the current epoch
        order = self._orders[epoch]
        start = (step * batch) % rows
        return [order[(start + i) % rows] for i in range(batch)]

    # -- Trainer protocol -------------------------------------------------
    def train_step(self, step: int) -> float:
        rows = [self._rows["train"][i] for i in self._indices(step)]
        input_ids, attention, labels = self._collate(rows)
        self._model.train()
        loss = self._model(input_ids=input_ids, attention_mask=attention, labels=labels).loss
        loss.backward()
        self._optimizer.step()
        self._optimizer.zero_grad(set_to_none=True)
        # A non-finite value is returned as is: the runner fails the run and never checkpoints it.
        return float(loss.detach().cpu())

    def evaluate(self, split: str) -> dict:
        torch = self._torch
        if split not in self._rows:
            raise KeyError(f"no split {split!r}; declared splits are {sorted(self._rows)}")
        rows = self._rows[split]
        self._model.eval()
        total_loss = 0.0
        total_tokens = 0
        correct = 0
        with torch.no_grad():
            for start in range(0, len(rows), 16):
                input_ids, attention, labels = self._collate(rows[start:start + 16])
                logits = self._model(input_ids=input_ids, attention_mask=attention).logits
                shift_logits = logits[:, :-1, :].float()
                shift_labels = labels[:, 1:]
                mask = shift_labels != -100
                if not bool(mask.any()):
                    continue
                token_loss = torch.nn.functional.cross_entropy(
                    shift_logits[mask], shift_labels[mask], reduction="sum")
                total_loss += float(token_loss)
                total_tokens += int(mask.sum())
                correct += int((shift_logits.argmax(-1)[mask] == shift_labels[mask]).sum())
        self._model.train()
        if total_tokens == 0:
            raise RuntimeError(f"split {split!r} has no response tokens to score")
        return {"loss": total_loss / total_tokens, "accuracy": correct / total_tokens,
                "examples": len(rows), "scored_tokens": total_tokens}

    def state_files(self) -> dict:
        torch = self._torch
        from peft import get_peft_model_state_dict

        def pack(obj) -> bytes:
            buffer = io.BytesIO()
            torch.save(obj, buffer)
            return buffer.getvalue()

        return {
            "adapter.pt": pack(get_peft_model_state_dict(self._model)),
            "optimizer.pt": pack(self._optimizer.state_dict()),
            "rng.pt": pack(torch.get_rng_state()),
        }

    def load_state_files(self, files: Mapping) -> None:
        torch = self._torch
        from peft import set_peft_model_state_dict

        def unpack(name: str):
            return torch.load(io.BytesIO(files[name]), map_location="cpu", weights_only=True)

        set_peft_model_state_dict(self._model, unpack("adapter.pt"))
        self._optimizer.load_state_dict(unpack("optimizer.pt"))
        torch.set_rng_state(unpack("rng.pt"))

    def export_artifact(self, directory: Path) -> list:
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        self._model.save_pretrained(str(directory))
        (directory / BASE_META).write_text(json.dumps({
            "baseId": self._job["base"]["id"],
            "baseRevision": self._job["base"]["revision"],
            "trainableParameters": self._trainable_count,
            "note": "LoRA adapter only. Load on the pinned base revision.",
        }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return sorted(p.name for p in directory.iterdir() if p.is_file())

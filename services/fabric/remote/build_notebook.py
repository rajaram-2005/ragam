"""Build the Colab notebook for the Klyvaron LoRA experiment. Run: python remote/build_notebook.py

The notebook is generated, not hand-edited, so its source can be reviewed as Python
here and so a test can detect a notebook that has drifted from its source.

It has NOT been executed. The authoring environment has no GPU, no route to
Hugging Face and no torch. Every cell is written against the libraries' documented
APIs, and the first real run is the first real test of it.
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "notebooks" / "klyvaron-chat-lora-colab.ipynb"

CELLS: list[tuple[str, str]] = []


def md(text: str) -> None:
    CELLS.append(("markdown", text.strip("\n")))


def code(text: str) -> None:
    CELLS.append(("code", text.strip("\n")))


md(r'''
# Klyvaron Chat LoRA experiment (Google Colab + Google Drive)

**Status: not executed.** Written against the documented APIs of PEFT, Transformers and
PyTorch, and tested only for syntax and for the fabric code it imports. The first real
run is the first real test of this notebook.

What it does: fine-tunes a LoRA adapter on a **third-party** pretrained base, pinned to a
commit, under the job contract in `fabric/training/jobspec.py`. It checkpoints to Google
Drive, resumes from the newest verified checkpoint, measures the base before training,
and writes a run record. It does not change any stable release.

What it does **not** do:

* It does not produce a Klyvaron model in the family sense (Lite, Pro or Max). The result
  is an adapter on someone else's base, and the record says so.
* It is not run by CI. CI has no GPU and installs no torch.
* It refuses to run on Kaggle. `/kaggle/working` is discarded when the session ends, so
  checkpoints written there would be lost. Kaggle needs an object-store writer first.

Before running: fill in `REPO_COMMIT`, the job file and the dataset (see
`docs/21-remote-training.md`). Each setting that still contains `REPLACE_` stops the run.
''')

code(r'''
# ---- Settings. Fill these in; the run refuses while any REPLACE_ value remains. ----
REPO_URL = "https://github.com/rajaram-2005/ragam.git"
REPO_COMMIT = "REPLACE_WITH_COMMIT_SHA"  # the exact commit the fabric code is taken from
JOB_FILE = "/content/drive/MyDrive/klyvaron/jobs/klyvaron-chat-lora-experiment.json"
DATASET_DIR = "/content/drive/MyDrive/klyvaron/datasets/klyvaron-chat-seed"
CHECKPOINT_ROOT = "/content/drive/MyDrive/klyvaron/checkpoints"
ARTIFACT_ROOT = "/content/drive/MyDrive/klyvaron/artifacts"

if "REPLACE_" in REPO_COMMIT:
    raise RuntimeError("Set REPO_COMMIT to a commit hash first.")
''')

code(r'''
# ---- Persistence check: checkpoints must reach storage that outlives the session. ----
import os

if os.path.exists("/kaggle"):
    raise RuntimeError(
        "This notebook refuses to run on Kaggle: /kaggle/working is discarded when the "
        "session ends, so checkpoints would be lost. Use Google Colab with Google Drive."
    )

from google.colab import drive  # noqa: E402  (Colab only)

drive.mount("/content/drive")
if not os.path.isdir(DATASET_DIR):
    raise RuntimeError(f"dataset folder not found: {DATASET_DIR}")
os.makedirs(CHECKPOINT_ROOT, exist_ok=True)
os.makedirs(ARTIFACT_ROOT, exist_ok=True)
print("Drive mounted. Datasets, checkpoints and artifacts will be read from and written to Drive.")
''')

code(r'''
# ---- Fetch the fabric code at the pinned commit. ----
import subprocess
import sys

REPO_DIR = "/content/ragam"
if not os.path.isdir(REPO_DIR):
    subprocess.run(["git", "clone", "--quiet", REPO_URL, REPO_DIR], check=True)
subprocess.run(["git", "-C", REPO_DIR, "fetch", "--quiet", "origin"], check=True)
subprocess.run(["git", "-C", REPO_DIR, "checkout", "--quiet", REPO_COMMIT], check=True)
head = subprocess.run(["git", "-C", REPO_DIR, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
if head != REPO_COMMIT:
    raise RuntimeError(f"checked out {head}, expected {REPO_COMMIT}")
sys.path.insert(0, f"{REPO_DIR}/services/fabric")
print("fabric code at", head)
''')

code(r'''
# ---- Libraries. Versions are recorded in the run record, not assumed. ----
%pip install -q "transformers>=4.45" "peft>=0.13" "accelerate>=0.34" "datasets>=3.0"
''')

code(r'''
# ---- Validate the job contract and check the GPU. Stops on the first unmet requirement. ----
import importlib.metadata as metadata
import json

import torch

from fabric.training.jobspec import JobSpecError, load_job

try:
    job = load_job(JOB_FILE)
except JobSpecError as refusal:
    print("Job refused. Every problem:")
    for problem in refusal.problems:
        print(" -", problem)
    raise

if not torch.cuda.is_available():
    raise RuntimeError("No GPU is attached. In Colab: Runtime > Change runtime type > GPU.")
gpu_name = torch.cuda.get_device_name(0)
gpu_memory_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
if gpu_memory_gb < job["resources"]["minGpuMemoryGb"]:
    raise RuntimeError(f"{gpu_name} has {gpu_memory_gb:.1f} GB; the job needs {job['resources']['minGpuMemoryGb']} GB")

versions = {name: metadata.version(name) for name in ("torch", "transformers", "peft", "accelerate", "datasets")}
environment = {"gpu": gpu_name, "gpuMemoryGb": round(gpu_memory_gb, 2), "versions": versions}
print(json.dumps(environment, indent=2))
''')

code(r'''
# ---- The trainer: PEFT LoRA on a pinned base. Implements the five methods of runner.Trainer. ----
import hashlib
import io
from pathlib import Path

import torch.nn.functional as F
from peft import LoraConfig, get_peft_model, get_peft_model_state_dict, set_peft_model_state_dict
from transformers import AutoModelForCausalLM, AutoTokenizer


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class PeftLoRATrainer:
    """Dataset rows are JSON objects with one key, "text". Formatting is the data's job."""

    def __init__(self, job, dataset_dir):
        self.job = job
        training = job["training"]
        base = job["base"]
        self.batch_size = training["batchSize"]
        self.max_length = training["seqLen"]

        self.tokenizer = AutoTokenizer.from_pretrained(base["id"], revision=base["revision"])
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        model = AutoModelForCausalLM.from_pretrained(base["id"], revision=base["revision"], torch_dtype=dtype)
        config = LoraConfig(
            r=training["rank"],
            lora_alpha=training["alpha"],
            lora_dropout=training["dropout"],
            target_modules=training["targetModules"],
            task_type="CAUSAL_LM",
        )
        self.model = get_peft_model(model.cuda(), config)
        self.params = [p for p in self.model.parameters() if p.requires_grad]
        self.optimizer = torch.optim.AdamW(self.params, lr=training["learningRate"])

        self.rows = {}
        self.rows["train"] = self._rows(dataset_dir, job["dataset"]["train"])
        self.rows["validation"] = self._rows(dataset_dir, job["dataset"]["validation"])
        for item in job["dataset"].get("regression", []):
            self.rows[item["name"]] = self._rows(dataset_dir, item)

    def _rows(self, dataset_dir, entry):
        path = Path(dataset_dir) / entry["file"]
        found = sha256_file(path)
        if found != entry["sha256"]:
            raise RuntimeError(f"{entry['file']} does not match the job: {found} != {entry['sha256']}")
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        if len(rows) != entry["examples"]:
            raise RuntimeError(f"{entry['file']} has {len(rows)} rows; the job says {entry['examples']}")
        return rows

    def _batch(self, rows, indices):
        encoded = self.tokenizer(
            [rows[i]["text"] for i in indices],
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=self.max_length,
        ).to("cuda")
        labels = encoded["input_ids"].clone()
        labels[encoded["attention_mask"] == 0] = -100
        return encoded["input_ids"], encoded["attention_mask"], labels

    def _token_loss(self, input_ids, attention_mask, labels):
        logits = self.model(input_ids=input_ids, attention_mask=attention_mask).logits[:, :-1]
        targets = labels[:, 1:]
        flat_logits = logits.reshape(-1, logits.size(-1)).float()
        flat_targets = targets.reshape(-1)
        return logits, targets, flat_logits, flat_targets

    @torch.no_grad()
    def evaluate(self, split):
        self.model.eval()
        rows = self.rows[split]
        loss_sum, tokens, correct = 0.0, 0, 0
        for start in range(0, len(rows), self.batch_size):
            indices = list(range(start, min(start + self.batch_size, len(rows))))
            input_ids, attention_mask, labels = self._batch(rows, indices)
            logits, targets, flat_logits, flat_targets = self._token_loss(input_ids, attention_mask, labels)
            loss_sum += F.cross_entropy(flat_logits, flat_targets, ignore_index=-100, reduction="sum").item()
            mask = targets != -100
            tokens += int(mask.sum())
            correct += int(((logits.argmax(-1) == targets) & mask).sum())
        self.model.train()
        return {"loss": loss_sum / max(tokens, 1), "accuracy": correct / max(tokens, 1), "examples": len(rows)}

    def train_step(self, step):
        self.model.train()
        training = self.job["training"]
        # The batch depends on (seed, step) only, so a resumed run draws the same batch.
        generator = torch.Generator().manual_seed(training["seed"] * 1_000_003 + step)
        indices = torch.randperm(len(self.rows["train"]), generator=generator)[: self.batch_size].tolist()
        input_ids, attention_mask, labels = self._batch(self.rows["train"], indices)
        _, _, flat_logits, flat_targets = self._token_loss(input_ids, attention_mask, labels)
        loss = F.cross_entropy(flat_logits, flat_targets, ignore_index=-100)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.params, 1.0)
        self.optimizer.step()
        self.optimizer.zero_grad(set_to_none=True)
        return float(loss.item())

    def state_files(self):
        buffer = io.BytesIO()
        torch.save(
            {
                "adapter": get_peft_model_state_dict(self.model),
                "optimizer": self.optimizer.state_dict(),
                "rng_cpu": torch.get_rng_state(),
                "rng_cuda": torch.cuda.get_rng_state_all(),
            },
            buffer,
        )
        return {"trainer-state.pt": buffer.getvalue()}

    def load_state_files(self, files):
        state = torch.load(io.BytesIO(files["trainer-state.pt"]), map_location="cpu", weights_only=False)
        set_peft_model_state_dict(self.model, state["adapter"])
        self.optimizer.load_state_dict(state["optimizer"])
        torch.set_rng_state(state["rng_cpu"])
        torch.cuda.set_rng_state_all(state["rng_cuda"])

    def export_artifact(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        self.model.save_pretrained(str(directory))
        return sorted(p.name for p in directory.iterdir() if p.is_file())
''')

code(r'''
# ---- Run. Writes the run record and the checkpoints; stops early if anything fails. ----
from fabric.training.checkpoint import CheckpointStore
from fabric.training.runner import run_job

out_dir = os.path.join(ARTIFACT_ROOT, job["jobId"])
os.makedirs(out_dir, exist_ok=True)
with open(os.path.join(out_dir, "environment.json"), "w", encoding="utf-8") as handle:
    json.dump(environment, handle, indent=2, sort_keys=True)

trainer = PeftLoRATrainer(job, DATASET_DIR)
store = CheckpointStore(os.path.join(CHECKPOINT_ROOT, job["jobId"]))
record = run_job(job, trainer, checkpoints=store, out_dir=out_dir)

print("status:", record.status)
if record.error:
    print("error:", record.error)
if record.results:
    print(json.dumps({k: record.results[k] for k in ("baseline", "final", "decision")}, indent=2))
''')

code(r'''
# ---- Candidate, or not. A candidate is a proposal; it changes no stable release. ----
from fabric.training.release import candidate_manifest

if record.status == "completed" and record.results["decision"]["eligible"]:
    manifest = candidate_manifest(job, record)
    path = os.path.join(out_dir, "candidate.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
    print("Candidate written (not a release):", path)
else:
    reasons = record.results.get("decision", {}).get("reasons") or [record.error]
    print("Not a candidate:", record.status, "-", "; ".join(str(r) for r in reasons))

# Copy the record, losses and environment to the logs location named in the job.
logs = job["logs"]["path"]
os.makedirs(logs, exist_ok=True)
for name in ("run-record.json", "losses.json", "environment.json"):
    source = os.path.join(out_dir, name)
    if os.path.exists(source):
        with open(source, "rb") as src, open(os.path.join(logs, name), "wb") as dst:
            dst.write(src.read())
print("Logs copied to", logs)
''')


def build() -> str:
    cells = []
    for kind, text in CELLS:
        lines = text.split("\n")
        source = [line + "\n" for line in lines[:-1]] + [lines[-1]]
        cell = {"cell_type": kind, "metadata": {}, "source": source}
        if kind == "code":
            cell["execution_count"] = None
            cell["outputs"] = []
        cells.append(cell)
    notebook = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
            "language_info": {"name": "python"},
            "colab": {"provenance": []},
        },
        "cells": cells,
    }
    return json.dumps(notebook, indent=1, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(build(), encoding="utf-8")
    print("wrote", OUTPUT)

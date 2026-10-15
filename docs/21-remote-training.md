# 21 — Remote training: the pipeline for Klyvaron Pro and Max

**Status, stated first:** the pipeline is built and tested against a NumPy fixture. **No
real base model has been fine-tuned.** No Klyvaron Pro or Max model exists. Lite is
the only trained Klyvaron model, and it was trained from scratch on this machine
(see [11 — Klyvaron family](11-klyvaron-family.md)). The notebook that runs a real LoRA
experiment on Google Colab has **not been executed**.

This page covers how Pro and Max get trained without a local GPU, what the pipeline
records and refuses, what was verified, and what was not.

## 1. Division of work

The laptop is an Intel Core Ultra 5 with no dedicated GPU. Training does not run on it.

| Work | Where it runs | Status |
| --- | --- | --- |
| Data preparation, job configs, licence and privacy checks | Laptop | Contract and checks built and tested |
| LoRA training | Free or authorised remote compute (Colab first) | Notebook written; **not executed** |
| Checkpoints | Persistent, authorised storage (Google Drive or an object store) | Store built and tested on local disk |
| Evaluation against baseline and regression sets | Wherever the run is | Built and tested on the fixture |
| Candidate manifest and stable-release rule | Laptop | Built and tested |
| CPU inference, quantisation, local runtime tests | Laptop | **Not done** (see §2) |

**Remote training does not make a model run locally.** A trained adapter still has to
run on the user's machine. Pro and Max deployment needs each model's hardware
requirements measured on that machine, as [13 — hardware execution policy](13-hardware-execution-policy.md)
requires. Nothing in this pipeline measures that.

## 2. The toolchain, and what each one has done here

| Tool | Role in this pipeline | Verified here |
| --- | --- | --- |
| Kaggle Notebooks | Candidate compute | No. The notebook refuses to run there (§8) |
| Google Colab | Compute, with Google Drive for storage | No. Notebook written and syntax-checked only |
| Hugging Face Transformers | Loads the pinned base model | No. Needs torch, which the repository forbids here, and Hugging Face is unreachable |
| PEFT (LoRA) | Adapter training | No. Notebook only |
| TRL | Not used. The plain training loop is simpler to audit. Add it only where a supervised loop needs its features | — |
| OpenVINO | Intel inference after a candidate exists | No. Not installed; nothing exported |
| llama.cpp and Ollama | Local testing of an adapter | No. The online entry can reach them through the synthetic loopback fixtures only ([19](19-online-only-phase-2.md)) |
| Sparsiz | Experiment manager and dataset pipeline | No. The pipeline writes its own run records (`aetheris-run-record/1`, from `fabric/run.py`). It is **not** integrated with Sparsiz, and the Sparsiz code was not inspected in this pass |

## 3. The job contract

A job is a JSON file, `schema: aetheris-training-job/1`. It says what trains, from what,
on what data, where checkpoints go, how the run is judged and how it resumes. The
validator returns **every** problem at once, and an invalid job is refused before any
compute is spent.

Required, and checked:

* **Base model:** an identifier, a `kind` (`third_party_finetune` or `fixture`), a
  **40-character commit hash** as `revision` (a branch or tag is refused), a licence on
  the allowlist, the licence URL at that revision, the name of the person who checked
  it, and the attribution text.
* **Dataset:** identifier, version, provenance, licence, a description, and
  `containsPersonalData: false`. Train and validation files each need a SHA-256 and at
  least the minimum example count. Validation needs at least 200 examples.
* **Training:** method, rank, alpha, dropout, target modules, learning rate, steps,
  batch size, sequence length and seed.
* **Resources:** accelerator, GPU memory needed, expected hours, maximum hours per
  session and storage. These are estimates until the first session measures them.
* **Checkpoints:** cadence, how many to keep, storage kind and path.
* **Validation:** the baseline name, the minimum loss gain, the minimum accuracy gain,
  the regression sets and the tolerance.
* **Output, logs and resume instructions.**

Refusals, each with a test:

* A placeholder (`REPLACE_` anywhere in a string) is a problem. The template in
  `services/fabric/remote/jobs/` is refused until a person fills in the base revision,
  the reviewer, the dataset hashes and the rest. A test confirms the template is refused
  only for its placeholders: filled with valid values, it is accepted.
* A licence not on the allowlist is refused: `Apache-2.0`, `MIT`, `BSD-2-Clause`,
  `BSD-3-Clause`, `CC0-1.0`, `CC-BY-4.0`. Non-commercial and share-alike terms are not
  on it, and neither is `unknown`. This is this repository's conservative default, not
  legal advice. Whoever runs a job reads the licence at the pinned revision.
* Data sent to a third-party service needs a named authorisation (`authorizedBy` and a
  reason). Data derived from conversations also needs consent and passed privacy and
  quality reviews.
* Personal data is never accepted for a remote job.
* A checkpoint path under a notebook session filesystem (`/kaggle/working`,
  `/kaggle/temp`, `/kaggle/input`, or `/content/` outside `/content/drive/`) is refused,
  because it is discarded when the session ends.
* A job that needs more than one session must checkpoint, because a session can end at
  any time and the free allowance is not promised.

## 4. Checkpoints and resume

Each checkpoint is one directory: `manifest.json` (the step, the config digest, a SHA-256
and size for each file, and metadata) plus the trainer's files.

* **Atomic.** Written to a staging directory, then renamed. A crash mid-save leaves
  nothing that looks like a checkpoint.
* **Verified on load.** Every file is re-hashed. A truncated or altered checkpoint is
  skipped, the reason is recorded, and the next older one is used.
* **Bound to one run.** The manifest carries the config digest: the base revision, the
  dataset hashes, the training configuration and the regression hashes. Storage
  locations and thresholds are excluded, so moving a checkpoint does not invalidate it.
  Changing the learning rate or the data does. A directory containing a checkpoint from
  a different configuration is **refused**, not resumed.
* **Never overwritten.** A verified checkpoint at a step is never replaced. A directory
  that fails verification is moved aside (never deleted), so the evidence is kept.
* **Retention.** The newest `keepLast` checkpoints are kept.

**Resume semantics.** The batch for step *n* depends only on the seed and *n*. On resume
the run loads the newest verified checkpoint and continues from its step.

* On the NumPy fixture this is **exact**: an interrupted and resumed run ends at the
  same adapter digest, and the same final metrics, as an uninterrupted run. A test
  checks this, and another checks that a corrupted newest checkpoint falls back to an
  older one and still ends at the same digest.
* On the notebook, the checkpoint also holds the optimiser state and the PyTorch random
  generators. Bit-identical reproduction on a GPU is **not** verified and is not
  promised, because GPU kernels are not guaranteed deterministic.

## 5. The acceptance gate and the status words

A run is judged against a **baseline measured on the same validation split before any
training step**, not against a number recalled from elsewhere. The run is a candidate
only if all of these hold:

1. Validation loss falls by at least `minImprovement` nats.
2. Validation accuracy rises by at least `minAccuracyGain`. **This criterion was added
   after the first fixture run.** A loss-only rule accepted a run whose loss fell only
   because an overconfident model became less confident. Its accuracy fell.
3. Validation has at least 200 examples.
4. Every regression set worsens by no more than `regressionTolerance`. A regression set
   that cannot be measured counts as failing.

The statuses are chosen so that none of them reads as more than it is:

| Status | Meaning |
| --- | --- |
| `refused` | The job failed validation, or the directory belongs to another run. Nothing trained. |
| `interrupted` | Stopped before finishing. It can be resumed. |
| `failed` | An exception, recorded with its type, message and a trace tail. |
| `completed` | The artifact exists on disk, its checksum was re-computed from the file, and the evaluation ran. **This does not mean the model is good.** |

Only `completed` with `decision.eligible = true` can become a **candidate**. A candidate
manifest records the base (with `independentlyPretrained: false`), the licence and its
check, the dataset hashes, the config, the baseline and final metrics, every file's
checksum, and the run record's digest. It does not change any stable pointer.

Replacing the stable release is a separate decision. `stable_replacement_problems`
refuses unless the candidate is eligible, the version is new, a named approver is given,
and the person releasing states that the acceptance suite passed. The code cannot run
that suite, so it does not pretend to.

## 6. Experience-driven examples

A good conversation can become a candidate training example. It passes one gate
(`fabric/training/experience.py`) before it is queued:

* the user consented, and the basis is recorded;
* no secret-like text (the existing redaction gate). Such an example is **rejected**,
  not repaired, because a redacted secret is still a leaked secret in the transcript;
* a named reviewer, and a quality score of at least 0.8.

Admission changes **no weights**. A queued example waits until a person starts a job that
names it, and that job then passes the same licence, privacy and provenance checks as any
dataset. A test checks that the admission module does not import the trainer or the
runner.

## 7. What was verified, and what was not

**Verified here** (Fabric suite: 678 tests, all passing under pytest 9.1.1; the 103 new
tests cover this pipeline):

* the job contract refuses each case listed in §3, and the template is refused only for
  its placeholders;
* the checkpoint store is atomic, verifies checksums, refuses mixed configurations,
  never overwrites a verified checkpoint, and keeps evidence of corruption;
* the hand-derived LoRA gradient matches finite differences;
* the acceptance rule accepts and rejects on crafted numbers, one branch at a time;
* on the fixture, the learnable-shift condition completes and improves but is **not**
  eligible because it forgets the source task, and the random-label condition completes
  and is **not** eligible because it gains only calibration;
* interrupted, resumed and corrupted-checkpoint runs end at the same adapter digest;
* the artifact on disk reproduces the evaluation it was judged on;
* a crash is recorded with its type and trace, and no artifact is claimed;
* mutation checks: removing the accuracy rule, skipping checksum verification, ignoring
  checkpoints on start, allowing notebook paths, or dropping the learning rate from the
  config digest each makes a test fail;
* the notebook is exactly what its builder produces, its code parses, and pyflakes
  reports no undefined names.

**Not verified:**

* **the notebook has not been run.** It has no GPU, torch or Hugging Face access here,
  so every call to PEFT, Transformers and PyTorch is written from their documentation,
  not exercised. The first real run is the first test of it;
* no base model has been downloaded, and no GPU training has happened;
* the Qwen licence was checked on the **`main`** branch only, not at any pinned commit;
* no adapter has been run under llama.cpp, Ollama or OpenVINO;
* the fixture is synthetic. It measures the pipeline, not any model's quality;
* no Klyvaron Pro or Max quality is claimed or implied.

## 8. Platform limits (checked 2026-10-15)

These limits set the design. They are not guarantees, and the job must not assume them.

* **Google Colab.** Google's FAQ says resources "are not guaranteed and not unlimited,
  and usage limits sometimes fluctuate." Idle VMs are deleted, and a maximum lifetime
  applies ([Colab FAQ](https://research.google.com/colaboratory/faq.html)). The free tier
  disallows SSH shells and running distributed computing workers. A job must checkpoint.
* **Kaggle.** Kaggle's GPU guide gives about 30 GPU hours a week and states a single
  session may run up to 9 hours ([Kaggle GPU tips](https://www.kaggle.com/page/GPU-tips-and-tricks)).
  A third-party guide cites 12 hours per session ([Ultralytics Kaggle guide](https://docs.ultralytics.com/integrations/kaggle)).
  The two disagree, so check the limit in your own account. The notebook refuses Kaggle
  for a different reason: `/kaggle/working` is discarded when the session ends.

Because these are free allowances, a job expected to take longer than one session must
checkpoint, and the job file says so (§3).

## 9. Base models and licences

Candidate base for the first experiment: **Qwen2.5-0.5B-Instruct**. Its `LICENSE` file on
the `main` branch is Apache License 2.0 ([Hugging Face LICENSE](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/blob/main/LICENSE)).
Qwen's own announcement says that "all of our open-source models, except for the 3B and
72B variants, are licensed under Apache 2.0" ([Qwen2.5 blog](https://qwenlm.github.io/blog/qwen2.5/)).
So **the licence is per model**, not per family. Before any run, read the licence file at
the pinned commit and record it in the job. This page does not choose a Pro or Max base.

## 10. Image and Video

Not started, and not part of this pass. The plan, when it is taken up: start Image with an
existing image model adapter; treat Video as processing and inference pipelines. Video
editing and template assembly are not "foundation-model training" and will not be
described as such.

## 11. Next steps, in order

1. **Prepare the first dataset** as JSONL rows with a single `text` key. Record its
   provenance and licence, and compute the SHA-256 of each file. Owner-authored or
   licensed data only, with authorisation for any third-party upload.
2. **Pin the base** to a commit, read its licence at that commit, and record the reviewer.
3. **Fill in the job** (copy the template from `services/fabric/remote/jobs/`) and upload
   it, the dataset and nothing else to Google Drive.
4. **Run the notebook** (`services/fabric/remote/notebooks/klyvaron-chat-lora-colab.ipynb`)
   in Colab with a GPU. Expect the first run to find errors. Replace the resource
   estimates with the measured peak memory and time.
5. **Read the run record.** Only an eligible candidate may be considered. An ineligible
   run is evidence, and it stays on record.
6. **Define the acceptance suite** before any release. It does not exist yet.
7. **Only then** consider Pro and Max, each with its own base, data, baseline and hardware
   measurement.

## Where the code is

* `services/fabric/fabric/training/` — `policy.py` (licences, provenance, storage),
  `jobspec.py` (the contract), `checkpoint.py` (the store), `runner.py` (the loop, the
  decision and the run record), `lora_fixture.py` (the NumPy fixture), `release.py`
  (candidates and the stable-release rule), `experience.py` (admission).
* `services/fabric/remote/` — the job template, the notebook, and `build_notebook.py`,
  which generates the notebook. Edit the builder and rerun it; never edit the notebook.
* `services/fabric/tests/test_training_*.py` — the tests described in §7.
* Run the fixture: `python -m fabric.training.lora_fixture --condition improves --out /tmp/run`.

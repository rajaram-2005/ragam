# 21 — Remote training: the free-first LoRA smoke run, and the path to Pro and Max

**Status, stated first.** The pipeline is built and its logic is tested. **No model has been
trained.** The first real run, one LoRA adapter on Kaggle (Colab as fallback), has **not
happened**: this sandbox has no GPU and no route to Kaggle, Colab or the Hugging Face hub
at run time. Every stage in §5 is therefore **NOT RUN** in the record. No Klyvaron Pro or
Max model exists. Lite is the only trained Klyvaron model, trained from scratch on this
machine ([11 — Klyvaron family](11-klyvaron-family.md)).

## 1. The first milestone

One real LoRA run, in this order, before anything is scaled toward Pro or Max:

1. Train a LoRA adapter on **Qwen2.5-0.5B-Instruct**, pinned to one commit, for 200 optimizer
   steps on **synthetic** starter data.
2. Save the adapter, reload it into a fresh model, and generate on a fixed prompt. Compare
   with the untrained base's output on the same prompt.
3. Read the adapter back from an attached output of an earlier committed run, to check that
   it persisted.

Each of those is reported on its own status line (§5). A stage that did not run is shown as
**NOT RUN**, never as a pass.

## 2. Free-first resources, and what they promise

Nothing here needs a purchased GPU, a personal GPU, a Google Drive upload, a manually
prepared dataset, a new account, or a paid service. The notebook never bypasses a quota.

* **Kaggle Notebooks (primary).** Kaggle's notebook documentation gives **12 hours** of
  execution for CPU and GPU sessions, and 9 hours for TPU
  ([Kaggle: getting started](https://www.kaggle.com/docs/notebooks)). That page also says up to
  **20 GB** may be saved in `/kaggle/working`, and that a longer computation should be run
  with **Save Version > Save & Run All**. The earlier 9-hour figure applied to TPU, not GPU.
  Both pages were re-checked on 2026-10-15. The GPU guide
  ([Efficient GPU Usage Tips](https://www.kaggle.com/docs/efficient-gpu-usage)) states a weekly
  GPU quota that "resets weekly and is 30 hours or sometimes higher depending on demand and
  resources", and a **60-minute** idle timeout for an interactive session. The older "GPU tips
  and tricks" page still claims 9-hour sessions and is out of date; it was not used. The job's
  `maxSessionHours: 12` is inside the documented session limit.
* **Google Colab (fallback).** Colab's FAQ says resources "are not guaranteed and not
  unlimited", idle VMs are deleted, a maximum lifetime applies, and the free tier does not
  allow SSH shells or distributed workers
  ([Colab FAQ](https://research.google.com/colaboratory/faq.html), re-checked 2026-10-15). The
  same page does give one figure the earlier version of this section missed: "In general,
  notebooks can run for at most 12 hours, depending on availability and your usage patterns",
  and Colab Pro+ up to 24 with compute units. It gives no GPU quota and no idle-timeout number
  at all — "Colab does not publish these limits", naming idle timeout periods, maximum VM
  lifetime and GPU types as things that vary over time. A 12-hour general cap is therefore
  documented; any specific idle figure is community-reported.
* **Hugging Face (model download).** The base is about 0.5 billion parameters, stored as
  `model.safetensors` in BF16 (about 1 GB). The notebook needs internet access to fetch it.

## 3. The base model: pin, licence, and what was checked

| Item | Value | Checked how |
| --- | --- | --- |
| Model | `Qwen/Qwen2.5-0.5B-Instruct` | Hugging Face model API, 2026-10-15 |
| Pinned commit | `7ae557604adf67be50417f59c2c2f167def9a775` | Hub API `sha` at that date. It is the `main` commit at that moment; the pin does not move if `main` does |
| Declared licence | `apache-2.0` | Model card metadata, Hub API |
| Licence text at the pinned commit | Apache License, Version 2.0 | `LICENSE` fetched at `/raw/7ae5576…/LICENSE`, this session |
| Parameters | 494,032,768, BF16 | Hub API `safetensors` field |

The licence is **per model**, not per family. Qwen's announcement, re-fetched on 2026-10-15, says
"All our open-source models, except for the 3B and 72B variants, are licensed under Apache 2.0"
([Qwen2.5 blog](https://qwenlm.github.io/blog/qwen2.5/)). Only the 0.5B model is used here.

Re-checked live on 2026-10-15, through the same Hub the run uses: the model API still resolves
`sha` `7ae557604adf67be50417f59c2c2f167def9a775`, still declares `license: apache-2.0`, and still
reports BF16 `494,032,768` parameters; the `LICENSE` fetched at that revision still opens
"Apache License / Version 2.0, January 2004", which is what `verify_model` looks for. The pin has
not moved.

The notebook checks the licence again at run time. `verify_model` in
`fabric/training/hf_peft.py` requires the hub's commit to equal the pin, the model card to
declare Apache-2.0, the `LICENSE` text to contain "Apache License" and "Version 2.0", and the
downloaded `model.safetensors` SHA-256 to match the hub's LFS hash. Any failure stops the run
before training. The check is recorded in the ledger as `model_verification`.

The job file records a **human** `licenceCheckedBy` field only as an automated check, with
"human review still pending". A person still has to read the file and record their name.

## 4. The synthetic starter dataset

Nobody has to supply data. `fabric/training/synthetic.py` generates it from fixed rules and a
fixed seed (`20261015`). Each row is a JSON object with a `text` field, in the form
`### Instruction:` / `### Response:`. Each row also carries `synthetic: true` and a label.

* **Families.** Addition, word reversal, letter count, uppercase, vowel count and number
  sorting, all for training. The answers are computed by Python. A separate held-out family
  of colour questions is used as the regression set, so it measures damage to behaviour the
  training never taught.
* **Disjoint.** No validation or regression text appears in training. A test checks it.
* **Labelled.** Every file, the manifest and the job's `contentsDescription` say SYNTHETIC.
  The job refuses a synthetic dataset whose description omits that word, or whose provenance
  is anything but `generated_locally`.

| File | Examples | SHA-256 |
| --- | ---: | --- |
| `train.jsonl` | 2000 | `70b11896f0f4c764886458727c290e9f967f2465ec5901ca0d67216b2bb28d57` |
| `validation.jsonl` | 300 | `571e78d2e87a0b4031efc7d2711eb125a1d171f1f984dd9e770ef227cbe88d5b` |
| `synthetic-regression.jsonl` | 40 | `41cb2f1c25695764d7aa085650fb99cbba9e6250606352b4a7ce1ef90fb3394b` |

The manifest digest is `b603cbb5dfa51a2af51ede77c8d2a018cdd5d4bf33739e8b57ad3ce55e3045d2`.
Two independent builds gave identical bytes. The job file pins these hashes, and a test fails
if the generator drifts from them.

The generated output depends on Python's `random` module. If a future Python changed it,
the notebook's pin check would refuse the data, and nothing would train on different bytes
silently. That refusal is intended.

**What this data is not.** It is not domain knowledge and not user data. A passing smoke run
shows the pipeline works. It says nothing about whether any model is useful.

## 5. The smoke run, stage by stage

`fabric/training/smoke.py` runs these stages in order and writes `status.json`. Each has its
own status: **PASSED** (ran and its check succeeded), **FAILED** (ran and failed, or raised;
the error is kept), or **NOT RUN** (not executed, because a prerequisite was missing or an
earlier stage failed).

| Stage | Needs a GPU | What it checks |
| --- | --- | --- |
| `environment` | no | Package versions, disk space, and the GPU if present |
| `model_verification` | no | The Hub commit, licence, LICENSE text and weight hash (§3) |
| `dataset` | no | The generated files match the job's pinned hashes and counts (§4) |
| `training` | yes | Baseline on the same split, then 200 LoRA steps, checkpoints, an artifact hashed from disk, and the acceptance decision |
| `reload` | yes | A **fresh** base model with the saved adapter attached; the adapter's recorded base revision must equal the pin; logits must be finite |
| `inference` | yes | The reloaded output on a fixed prompt differs from the untrained base's. This shows the adapter is applied. It is **not** a quality measure |
| `quality` | yes | The job's acceptance gate (§9). PASSED only if the gate is met on synthetic validation |
| `persistence` | yes | The adapter was read back from an attached output of an earlier committed run. Otherwise **NOT RUN** |

**Verdict.** `REFUSED` if the job breaks a rule (nothing runs). `FAILED` if a technical stage
failed. `NOT ACCEPTED` if every stage ran but the gate refused the adapter. `PASSED` if every
core stage passed. `INCOMPLETE` otherwise, for example with no GPU. `PASSED` never says the
output persisted; that needs the `persistence` stage.

**Training choices.** Weights are float32, a deliberate choice for a 0.5B model on a 16 GB
GPU, to avoid precision failures that look like pipeline bugs. LoRA rank 8, alpha 16, dropout
0.05, on the attention projections. The loss is taken on the answer tokens only, with the
prompt masked. Batches come from the step number alone, so a resumed run reads the same data
in the same order.

**Not promised.** GPU kernels are not guaranteed to be deterministic. A resumed run is
expected to match an uninterrupted one on the fixture, which is pure NumPy. On the GPU that
match is **not verified**.

## 6. Storage, and what Kaggle keeps

This section corrects an earlier version of this page, which said `/kaggle/working` is
"discarded when the session ends". That was too strong.

* `kaggle_output`: paths inside `/kaggle/working/` only. Kept as the output of a **committed**
  version (Save & Run All). An interactive session that is not committed can lose its files.
  Persistence is claimed only after a read-back through `/kaggle/input` (the `persistence`
  stage).
* `colab_session`: the Colab runtime disk. Lost when the runtime ends. A job must acknowledge
  this (`ephemeralAcknowledged: true`). The notebook sets that itself on Colab, and the ledger
  notes it.
* `google_drive`, `object_store`, `local_disk`: kept as before.
* `/kaggle/input` is read-only. It is accepted only as a `checkpoint.resumeFrom` source.
  Anything else under it is refused.
* `resumeFrom`: the newest verified checkpoint of the **same** configuration is copied into the
  working store. A checkpoint from another configuration is refused. A newer local checkpoint
  is never replaced by an older attached one.

The Kaggle documentation supports these facts. Only a read-back through `/kaggle/input`
verifies persistence.

## 7. Sparsiz: inspected, not integrated

Commit `76ec6f0f0f501ea9fbf99f0769ef224d3dbc0d69` of
`github.com/rajaram-2005/sparsiz`, cloned read-only and re-measured line by line on
2026-10-15. Findings:

* **torch** is imported in exactly one file, `sparsiz/saram.py`, which defines a small MSE
  autoencoder whose physics term is a comment-labelled "dummy loss". The word also appears in
  `setup.py`'s dependency list and in one comment under `intelligence/saram/encoder/`; neither
  imports it. **Nothing in the repository calls `backward()`, an optimizer, or `.step()`.**
  No model is trained there.
* **No Transformers, no PEFT** — zero lines name either. **No LoRA is implemented:** the seven
  lines that name it are prose and printed labels about a conceptual temporary adapter in the
  L0–L4 story, with no module and no dependency behind them. **No checkpointing code exists**
  — zero lines name a checkpoint.
* **`sparsiz/training/`** (12 modules) scores with `random.uniform` and `random.random` — 132
  such lines across `sparsiz/`, 27 of them inside `sparsiz/training/`: data quality, evaluation
  baselines, RL rewards, evolution, distillation verification, synthetic data and curriculum.
  96 lines across `sparsiz/` name themselves dummy, placeholder or simulated (10 of them inside
  `sparsiz/training/`). An earlier version of this page said "about 35 lines"; that number did
  not reproduce at the pinned commit under any pattern tried, and the measured counts replace it.
* **No test** covers any training module: the four test files import `sparsiz.faisanth`,
  `sparsiz.premsoth`, `sparsiz.rajaram` and `sparsiz.saram`, and nothing from `sparsiz.training`.
* `training/README.md` describes a pipeline that is not implemented.

**Decision.** No Sparsiz code is reused, and Sparsiz is not integrated. Its scoring is
simulated, so reusing it would present simulated results as training. The SHA-256 dedupe idea
is the same as the manifest in §4, implemented here. A `ContaminationDetector` in Sparsiz's
DataForge uses Python's `hash()`, which varies between processes, so it is not reproducible.
Because no functioning backend existed, the Transformers + PEFT backend is written **inside
fabric**, isolated in `hf_peft.py`, with torch imported lazily.

## 8. Checkpoints and resume

Each checkpoint is a directory with `manifest.json` (the step, the config digest, and a
SHA-256 and size per file) plus the trainer's files.

* **Atomic.** Written to a staging directory, then renamed.
* **Verified on load.** Every file is re-hashed. A corrupt checkpoint is skipped, the reason
  is recorded, and the next older one is used.
* **Bound to one configuration.** The config digest covers the base revision, the dataset
  hashes, the training settings and the regression hashes. Storage locations and thresholds
  are excluded. A directory holding another configuration's checkpoint is **refused**.
* **Never overwritten.** A verified checkpoint is never replaced.
* **Retention.** The newest `keepLast` are kept.

On the NumPy fixture, an interrupted and resumed run ends at the same adapter digest as an
uninterrupted one, including after a corrupt newest checkpoint. The GPU case is not verified.

## 9. The acceptance gate

A run is judged against a baseline measured on the same validation split before any step. It
is a candidate only if:

1. Validation loss falls by at least `minImprovement` nats.
2. Validation accuracy rises by at least `minAccuracyGain`. A loss-only rule accepted a run
   whose loss fell only through calibration, with accuracy down. The accuracy rule was added
   after that happened on the fixture.
3. Validation has at least 200 examples.
4. Every regression set worsens by no more than `regressionTolerance`. An unmeasured set
   counts as failing.

The job's thresholds are unchanged from the earlier scaffold, so they were not tuned for this
run.

Only an eligible run can become a **candidate**. A candidate manifest records the base (with
`independentlyPretrained: false`), the licence check, the dataset hashes and the run record's
digest. It does not change any stable pointer. Replacing the stable release needs a named
approver and an explicit acceptance statement (`fabric/training/release.py`). The code cannot
run that acceptance suite, so it does not pretend to.

## 10. Experience-driven examples

A conversation can become a candidate example only after `fabric/training/experience.py`
checks: consent with the basis recorded; no secret-like text, which is **rejected**, not
repaired; a named reviewer; and a quality score of at least 0.8. Admission changes no weights.
A queued example waits for a person to start a job that names it, and then passes the same
licence, privacy and provenance checks as any dataset. A test checks that this module never
imports the trainer or the runner.

## 11. What was verified, and what was not

**Verified here** (fabric suite, pytest, this session):

* The full fabric suite passes. Its totals are in the table in `docs/03`, and the docs guard
  checks them.
* The job contract refuses each rule in §6 and the synthetic-labelling rule, and the template
  validates with no placeholder left.
* The storage rules refuse notebook paths used for the wrong kind, `..` escapes, and resume
  sources outside `/kaggle/input`.
* The ledger keeps each stage separate. A failed licence check stops training. Data that does
  not match its pins stops training. A non-finite loss is never checkpointed. Persistence
  passes only on a read-back. A refused job runs nothing. The verdict vocabulary is fixed.
* The synthetic data is deterministic, disjoint and correctly labelled. Every training answer
  is recomputed and checked.
* The checkpoint import copies only the newest verified checkpoint of the same configuration,
  and does not overwrite a newer local one.
* The Hub gate refuses a wrong revision, a non-Apache licence text, a declared-licence
  mismatch, a weight-hash mismatch and a missing hub hash. These run with an injected fake Hub.
* Batch order depends only on the step, and one epoch visits each row once. The loss is taken on
  the answer only.
* **Mutation checks.** Nine rules were removed one at a time in a scratch copy: the
  model-verification gate, the dataset-pin gate, the `kaggle_output` path rule, the synthetic
  label check, the Colab acknowledgement, the persistence rule, the resume-source rule, the
  import overwrite guard, and the verdict's quality rule. Each removal made a test fail.
  The import guard was not caught at first, because the test did not check the store's
  contents; that test was fixed and the mutation then caught.
* **The mutation checks were reproduced on 2026-10-15, and each is caught by a named test.**
  The whole suite was run after every removal, in a copy of the checkout, and the run stopped
  the moment one removal left the suite green — it did not. Rule to catching test:

  | Rule removed | Caught by |
  | --- | --- |
  | model-verification gate (`hf_peft.py`) | `test_the_hub_gate_refuses_a_revision_it_did_not_resolve` |
  | dataset-pin gate (`smoke.py`) | `test_data_that_does_not_match_its_pins_stops_training` |
  | `kaggle_output` path rule (`policy.py`) | `test_kaggle_output_refuses_paths_outside_the_working_directory` (5 cases) |
  | synthetic label check (`jobspec.py`) | `test_a_synthetic_dataset_must_be_generated_locally_and_say_so` |
  | Colab acknowledgement (`policy.py`) | `test_colab_session_paths_need_an_explicit_ephemeral_acknowledgement` |
  | persistence rule (`smoke.py`) | `test_a_clean_run_with_a_gpu_passes_every_core_stage`, `test_persistence_is_not_claimed_without_a_read_back` |
  | resume-source rule (`policy.py`) | `test_resume_sources_are_read_only_attached_outputs` |
  | import overwrite guard (`checkpoint.py`) | `test_nothing_is_imported_when_the_local_store_is_already_as_new` |
  | the verdict's quality rule (`smoke.py`) | `test_a_candidate_the_gate_refuses_is_not_accepted_but_is_still_tested` |

  This is a script now, not a memory: `python services/fabric/scripts/mutation_check.py` copies
  the repository once per rule, removes one rule, runs the suite and fails loudly if a removal
  escapes — or if a rule's anchor text has moved, which would mean the check itself went stale.
  It is deliberately not in CI: it is about four minutes of suite runs, and it only needs
  re-running when one of these rules or this section changes.
* **Every CI step was run on this checkout, not just read.** The zero-dependency check on
  `services/core`; the core suite (567); `numpy` present and `torch` **not** importable; the
  advisory audit against the live GitHub Advisory Database (5 packages, none covered, exit 0);
  the fabric suite (747); the release gate end to end — `partial` status, a released
  `aetheris-lite-retriever@0.1.0` at mrr 0.8497, and the undertrained run refused; the web
  suite (92); `npm audit` clean on the production tree and the full tree; the production build;
  the bundle check (no loopback URL, no credential-shaped string); the docs guard (39); and the
  licence copies (all present, none truncated). This is the same work the four CI jobs do, and
  it passed here and on the pull request.
* The notebook is exactly what its builder produces, its code parses, it calls the tested
  orchestration, it needs no Drive mount, and it says it has not been executed.
* The docs guard (`services/core/test/docs.test.mjs`) holds the counts in the README, docs 02–05,
  the fabric README and this page. It is re-run after any count changes.
* **Re-verified on 2026-10-15, on this checkout** (a second pass, after the build pass): the
  fabric suite is 747/747 and the core suite 567/567; the synthetic data regenerates to the §4
  hashes byte-for-byte in two independent builds; every package pin in §12 exists on PyPI at
  that exact version; and `hf_peft.py`'s calls were re-read against those exact wheels —
  `dtype` plumbing with `torch_dtype` kept for back-compatibility in `from_pretrained`,
  `generate(input_ids=…)`, `LoraConfig` as a dataclass over `PeftConfig` (so `task_type` is a
  valid argument), `get_peft_model_state_dict`, `set_peft_model_state_dict`,
  `PeftModel.from_pretrained`, and `model_info(files_metadata=True)` →
  `sibling.lfs.sha256`. Peft 0.21.2's own imports from Transformers 5 (`Conv1D`,
  `ALL_LAYERNORM_LAYERS`, `cached_file`, `http_user_agent`) still exist in 5.19.0. §7 was
  re-measured from a fresh clone of the pinned commit, which is where the corrections to it
  come from. §2's Kaggle and Colab figures were re-read from Kaggle's documentation and
  Colab's FAQ, and §3's pin, declared licence and parameter count were re-resolved through the
  Hub, with the `LICENSE` at the pinned revision fetched again; those re-checks are recorded in
  §2 and §3.
* The notebook clones the published branch, and a test fails if it is pointed at a session
  branch — see the defect list in §12.

**Not verified:**

* **The real backend has never run.** `hf_peft.py` (torch, Transformers, PEFT) has no torch
  here. Its calls are written against the installed API signatures: `AutoModelForCausalLM`
  with `dtype=`, `LoraConfig`, `get_peft_model`, `get_peft_model_state_dict`,
  `set_peft_model_state_dict`, `PeftModel.from_pretrained`, and `hf_hub_download`,
  `snapshot_download`, `model_info(files_metadata=True)`. These were checked against the
  wheels for the versions in §12. Their behaviour at run time was not.
* **The notebook has never run.** It has no GPU and no route to Kaggle, Colab or Hugging Face.
  The first run is the first test of it, and it will likely find errors.
* **Package compatibility with Kaggle's preinstalled torch** is not checked. The notebook pins
  `transformers` 5.19.0 and `peft` 0.21.2, and may have to adjust them.
* **The GPU, memory and time.** The job's `minGpuMemoryGb: 8`, `expectedHours: 0.5` and the
  200 steps are estimates, not measurements.
* **Persistence.** No Kaggle output has been read back.
* **Quality.** No quality claim is made or implied, for this model, the data, or any tier.
* No adapter has run under llama.cpp, Ollama or OpenVINO.

## 12. Run record: the fields the first run must report

These are the fields the final report must contain. Each is filled from a real run, not from
expectation. **Nothing has been run, so every value below that depends on a run is NOT RUN.**

| Field | Value |
| --- | --- |
| Sparsiz commit | `76ec6f0f0f501ea9fbf99f0769ef224d3dbc0d69` (inspected; not used) |
| Repository commit | recorded by the notebook in `status.json` (`context.repoCommit`). NOT RUN |
| Base-model commit | `7ae557604adf67be50417f59c2c2f167def9a775` (pinned; resolved at run time: NOT RUN) |
| Licence | Apache-2.0; LICENSE text checked at the pinned commit in this session; run-time check NOT RUN |
| Dataset hash | train `70b11896…`, validation `571e78d2…`, regression `41cb2f1c…`; manifest digest `b603cbb5…` (generated and checked in this session) |
| Environment versions | NOT RUN. Pins: transformers 5.19.0, peft 0.21.2, accelerate 1.15.0, huggingface_hub 2.2.0, safetensors 0.8.0; torch is whatever Kaggle provides |
| Detected GPU | NOT RUN |
| Optimizer steps | NOT RUN (target 200) |
| Loss | NOT RUN |
| Checkpoint location | NOT RUN (planned `/kaggle/working/aetheris-smoke/checkpoints`) |
| Reload result | NOT RUN |
| Inference result | NOT RUN |
| Metrics | NOT RUN |
| Persistence | NOT RUN |
| Failures | None recorded: nothing has run. Defects found and fixed before any run are listed below (two passes) |
| Next step | Import the notebook on Kaggle (GPU, Internet on), then Save & Run All. Then run the persistence check |

Defects found and fixed in the build pass, before any run: the policy refused `/kaggle/working`,
which Kaggle keeps as output; `normpath` collapsed `s3://` URIs, so every object-store path
would have been refused; training continued after a failed licence check; the verdict had no
way to say a gate refused a candidate; and one test was too weak to catch a real defect.

Defects found and fixed in the audit pass of 2026-10-15, before any run: the notebook cloned the
session branch `arena/11d936e0-ragam`, which stops resolving when that session ends, so a run
started later would have failed at `git clone`; it now clones `main`, the commit it actually
gets is still recorded in `status.json`, and a test refuses a session branch. Three claims in §7
about Sparsiz were wider than the code at the pinned commit and are corrected there to the
measured numbers. `hf_peft.py`'s docstring named `tests/test_training_hf_backend.py`, a file that
does not exist: the Hub gate tests live in `tests/test_training_resume_and_backend.py`. The
docstring now names the file that exists. §2's Colab bullet also said the FAQ gives no lifetime
figure; it does, a general 12-hour cap, and §2 now says so.

## 13. Base models, and image and video

Only Qwen2.5-0.5B-Instruct is in use. Pro and Max bases are not chosen here. Each needs its own
licence check at its pinned commit, its own baseline, and its own hardware measurement.

Image and Video are not started. The plan is unchanged: start Image with an existing image
model adapter, and treat Video as processing and inference pipelines, not "foundation-model
training".

## 14. Next steps, in order

1. **Run the smoke notebook once on Kaggle.** Import `services/fabric/remote/notebooks/klyvaron-chat-lora-smoke.ipynb`
   from the repository, set Accelerator to GPU and Internet to On, then Save & Run All.
   Expect errors on the first run.
   The first cell stops before anything is trained if it cannot clone, and it now says which
   failure it hit instead of raising a bare exit code:

   * `Could not resolve host: github.com` — **the Internet switch is off**, which is the default
     on Kaggle. Set it to On in the Settings panel and run again. This is the failure the first
     attempt at this notebook actually hit.
   * `Remote branch … not found` — a copy of the notebook that pins a branch which has since been
     deleted, which is what a saved copy does when its working session ends. Re-import the
     notebook, or set `REPO_REF = "main"`.
2. **Read `status.json`.** Each stage shows PASSED, FAILED or NOT RUN. Fill in §12 from it.
3. **Persistence check.** Copy the notebook, add the committed version's output as an Input,
   set `PERSISTENCE_ADAPTER`, and run again.
4. **Replace the estimates** in the job with the measured memory and time.
5. **Record a human licence review** in `licenceCheckedBy`, in place of the automated entry.
6. Only after the smoke run passes end to end: consider scaling. Pro and Max each need their own
   base, data, baseline and hardware measurement, and a defined acceptance suite, which does not
   yet exist.

## Where the code is

* `services/fabric/fabric/training/` — `policy.py` (licences, provenance, storage), `jobspec.py`
  (the contract), `synthetic.py` (the starter data), `smoke.py` (the stage ledger),
  `hf_peft.py` (the Transformers + PEFT backend, isolated), `checkpoint.py` (the store and the
  import), `runner.py` (the loop, the decision, the run record), `lora_fixture.py` (the NumPy
  fixture), `release.py` (candidates and the stable rule), `experience.py` (admission).
* `services/fabric/remote/` — the job template `jobs/klyvaron-chat-lora-experiment.json`, and the
  notebook `notebooks/klyvaron-chat-lora-smoke.ipynb`, generated by `build_notebook.py`. Edit the
  builder and rerun it; never edit the notebook.
* `services/fabric/tests/test_training_*.py` — the tests described in §11.
* The superseded Colab-and-Drive design, in commit `3dc8fb1` on this branch, was replaced by the
  free-first design above.

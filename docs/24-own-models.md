# 24 — Pro and Max are our own models: `aetheris-core-v1`

**Status, stated first.** The architecture exists as data and as code. **The weights do not exist.**
Pro and Max are `unbuilt`, `klyvaron-pro-lm` and `klyvaron-max-lm` have no artifact, and the family
plan keeps `artifact`, `measurements` and `own_weights` open until a real training run produces a
real file that could be served. They are `aetheris-core-v1` presets **trained from random
initialisation** on the machine that will run them — no base checkpoint, and the rule is enforced
rather than documented: `validateArchitecture()` refuses a preset that names one. Lite is the third preset of the same architecture and is
released: the formula in this page reproduces its 359,616 parameters exactly from its configuration,
and a test checks both against the released model card.

```bash
node services/core/scripts/klyvaron.mjs arch            # all three presets, configs and arithmetic
node services/core/scripts/klyvaron.mjs arch pro --tokens 1000000000
node services/core/scripts/klyvaron.mjs plan            # the gates, including own_weights
```

---

## 1. The decision: ours, not someone else's

An earlier version of this plan gave Pro and Max a third-party base: an unmodified, licence-checked
model downloaded to the user's machine and wrapped in this repository's mechanisms. That path needs
no training and is documented in [23](23-training-free-tiers.md) — and it was rejected. It delivers
someone else's weights, under someone else's licence, with our tier label above them. A model of
this family has to be this family's model.

That decision has a consequence, stated here rather than discovered later: **new weights come from
training, and there is no technique that avoids it.** Model merging, distillation and quantisation
all start from trained weights; a random initialisation is the only starting point that owes nothing
to anyone, and it has to be trained. So the question is not *whether* Pro and Max are trained, it is
*whose machine* trains them. The answer is the one the tiers already name:

| | Lite (released) | Pro | Max |
|---|---|---|---|
| Where the weights are created | this host, 2 CPU cores | the user's own GPU or NPU | the user's own GPU or NPU |
| Where they run | the same machine, CPU | the same machine | the same machine |
| What is downloaded | the `.npz`, referenced by digest | nothing: the machine builds them | nothing: the machine builds them |

That is what "no third-party model" buys, and it is why the composed path is not merely unused but
refused: `own_weights` can only be met by an artifact of this family, and a composition can never
be one.

## 2. The architecture

One design, three sizes. `services/core/src/klyvaron/architecture.mjs` records it as data, and every
arithmetic figure in this page is derived from those records rather than typed beside them.

| Component | Why it is the way it is |
|---|---|
| Pre-LayerNorm blocks | Post-LN needs a warmup schedule to train from a cold start; pre-LN does not. |
| Learned positional embeddings | At these context lengths there is nothing to extrapolate to, and it is one less function to get wrong. |
| GELU MLP (tanh approximation) | NumPy has no `erf`, and SciPy is deliberately not a dependency. |
| Tied embedding and head | At these sizes the embedding is a large share of all parameters; tying is a real improvement, not a shortcut. |
| Residual outputs scaled by `1/sqrt(2L)` | Without it the residual stream grows with depth and the final LayerNorm sees a scale that depends on layer count. |
| Hand-derived backward passes, finite-difference checked | A wrong gradient does not crash; it trains a model that quietly learns nothing. |

**What it deliberately does not have**, because a reader would otherwise assume it:

* **Grouped-query attention.** The KV cache is `n_heads` times a grouped design at the same context.
  Max pays 12× — 1.21 GiB at 32,768 tokens in fp16 — and that is printed, not discovered at run time.
* **Rotary position embeddings.** Learned positions cannot extrapolate past the trained context; the
  context is a config value, not a promise.
* **Mixture-of-experts, dropout, distributed training.** Every parameter is used on every token; a
  config that asks for dropout is refused rather than silently ignored.
* **Instruction tuning.** This architecture describes a *pretrained base*. An instruction-tuned
  variant is a separate artifact with its own evaluation, not a config flag.

The trainer that implements this architecture is `services/fabric/fabric/lm/train.py` — pure NumPy,
no PyTorch, no CUDA kernels. It is the reason a from-scratch model was buildable here at all
([08](08-aetheris-lite.md)), and it is also the reason the `backend` step below is open: NumPy on the
CPU cannot use the accelerator Pro and Max target.

## 3. The presets

Four of them: three tiers, and `mini`.

`mini` is not a tier. It is the size this host can train in a single sitting of a few hours, so it
is the preset that proves the architecture, the corpus assembly, the tokenizer, the trainer, the evaluation gate and
the release card work end to end on real text — for a few hours of CPU rather than a week of
someone's GPU. Its card names its family as `klyvaron-mini`, not as Pro or Max.

Its card is `docs/model-cards/klyvaron-mini-lm-0.1.0.md` (machine-readable beside it), and its run
record is `docs/experiments/klyvaron-mini-lm-run.json`.

The run producing it finished, and its outcome is measured rather than rested on: 4,000 steps in
8,456 s of wall clock at 192/3/4/768/128 on two cores, loss 5.7551 → 0.8157, held-out perplexity
**4.7342** against a bigram baseline of **15.8644**, unknown rate 7.0 × 10⁻⁵. The gate released it
with **0 hard failures and one soft failure**: 8,456 s against a 3,600 s wall-clock target that was
written for a smaller run and was **not relaxed** to let this one through. The miss is on the card
and in its own limitation list. `docs/experiments/klyvaron-mini-lm-run.json` reads
`running` until the report exists, and the preset in `architecture.mjs` claims no artifact until
then.

### The run in flight: `klyvaron-mini-lm@0.2.0`

`mini` is the size this host can train. When the corpus and the tokenizer changed, the size it can
train changed with them, so the second release of the same preset is a different network rather
than a longer training of the first one:

| | 0.1.0 | 0.2.0 |
|---|---|---|
| Vocabulary | 352 characters | 4,096 byte-BPE tokens (256 bytes + 3,840 merges) |
| Shape | 192 / 3 / 4 / 768, context 128 | 256 / 4 / 8 / 1,024, context 256 |
| Parameters | 1,421,952 | 4,260,096 |
| Corpus | 13.65 MB, this repository's text and six small sources | 167.94 MB, 17 licence-checked sources |
| Tokens seen | 8,192,000 (character) | 56,934,400 (subword) |
| Evaluation | 1,907,072 held-out characters | 5,926,828 held-out tokens, four sources held out whole |

The two are **not comparable by perplexity**: a character tokenizer and a subword one score different
units, and the same corpus read by each yields different tokens. What can be compared is each model
against the baselines computed on its own held-out text, which is what both cards quote.

Every number in the run was measured on this host before the run was launched rather than assumed:

* **4.47 s per step** at this shape (12 timed steps after 3 discarded for BLAS warm-up), so
  13,900 steps is ~17.8 hours;
* **2,481 tokens/s** during evaluation, so the 5,926,828-token held-out pass costs ~40 minutes —
  and the day's budget includes it;
* **learning rate 2 × 10⁻³**, chosen from a 300-step probe at each of 1 × 10⁻³ and 2 × 10⁻³ on the
  real token stream: 2 × 10⁻³ ended at 4.1087 against 1 × 10⁻³'s 4.2708 and led at every checkpoint,
  with gradient norms falling to 0.788 and no spike. 3 × 10⁻³ was entered and **not finished**, so
  the record says nothing about it — an unmeasured rate is not a rejected one.

The run will trip the same soft failure 0.1.0 did: the gate's 3,600 s wall-clock target is not
relaxed for a run whose wall is measured in hours. That miss is expected, is stated here before the
result is known, and belongs on the card.

**A long run now checkpoints.** Every 500 steps (about 38 minutes) the full training state —
weights, Adam's moment estimates, the loss curve and the step — is written to
`<run>-<configDigest12>.ckpt.npz`, atomically, so a crash mid-write cannot destroy the last good
state. `train_lm.py --resume-from` continues from it, and `tests/test_lm_train.py` proves the
property that matters: it kills a real training process, resumes from what that process left on
disk, and asserts the result is **bit-identical** to the run that was never interrupted — same loss
at every step, same weight digest. Resuming under a different configuration is refused, because
`steps` is part of the configuration and the learning-rate schedule depends on it: the state of a
six-step plan is not the state of a twelve-step one.

This exists because of what happened to 0.1.0. An eighteen-hour run that dies at hour seventeen with
no checkpoint has produced nothing — not the model, not even evidence of how far it got.

| | Lite | Mini | Pro | Max |
|---|---|---|---|---|
| Model | `aetheris-lite-lm` | `klyvaron-mini-lm` | `klyvaron-pro-lm` | `klyvaron-max-lm` |
| Vocabulary | 148 (character) | 352 (character) | 4,096 | 8,192 |
| `d_model` / layers / heads | 96 / 3 / 4 | 192 / 3 / 4 | 512 / 8 / 8 | 768 / 12 / 12 |
| `d_ff` / context | 384 / 128 | 768 / 128 | 2,048 / 512 | 3,072 / 1,024 |
| Parameters | **359,616** | **1,421,952** | **27,559,946** | **92,077,066** |
| — of which the differentiator parts | none | none | 17,418 | 26,122 |
| Weights, int4 → fp16 | 0.2 → 0.7 MB | 0.7 → 2.7 MB | 13.8 → 55.1 MB | 46.0 → 184.2 MB |
| Optimiser state, Adam fp32 | 5.8 MB | 21.7 MB | 440.9 MB | 1.37 GiB |
| Artifact | released, `0.1.1` | released, `0.1.0` | **none** | **none** |

The vocabulary is *data*, not a design choice: Mini's 352 characters are the tokenizer fitted on
that run's training split, and the preset carries that number because the config the trainer writes
carries it. Train the same preset on a different corpus and the parameter count moves with the
alphabet — which is why the preset is checked against the run's own record
(`docs/experiments/klyvaron-mini-lm-run.json`) by `test/architecture.test.mjs` rather than trusted.

Mini has no differentiator parts, and that is a deliberate limit rather than an oversight. Labelling
a general-purpose corpus with the age of the evidence behind each token, and with the state a
person expressed, is a *mechanism* that does not exist yet; a config that switched the parts on
would be claiming a capability the data cannot train. The parts are implemented in the trainer and
measured separately (§7), and they stay off until the labels they need are real.

The parameter formula is the trainer's own: `vocab*d + seq*d + L*(4d² + 2*d*ff + 4d) + 2d`, with the
head counted only when the embeddings are not tied, plus the differentiator parts in §7. For Lite
that is 14,208 + 12,288 + 332,928 + 192 = 359,616, the number on the released card — and the parts
are zero there, because the released configuration predates them and its record keeps what it was
trained with.

`Pro` is 28 M parameters and not 280 M for a reason that is arithmetic rather than ambition: Adam in
fp32 needs 16 bytes per parameter, so 92 M parameters of optimiser state fit on a 12 GB card with
room for activations, and a billion-parameter model's optimiser state does not fit at all. A model
that cannot be trained on the machine the tier names is not a tier of this family.

## 4. The corpus: licence-checked, and held out by source

The recipe's first step is the one that decides whether the rest is allowed. `scripts/assemble_corpus.py`
assembles the corpus and refuses anything it cannot license:

* Each source is resolved to a **commit SHA** and the licence is read **at that SHA**, not from the
  default branch, because a licence can change and a moving ref is not a base.
* The SPDX id must be on the same allowlist the composed path uses (`Apache-2.0`, `MIT`,
  `BSD-2-Clause`, `BSD-3-Clause`, `CC0-1.0`, `CC-BY-4.0`), and it must be the licence the source was
  added for. `--check-core-allowlist` fails if the two copies of that list ever diverge.
* Nothing is written for a source that fails either check: a refused source contributes zero bytes.

That last rule has already done work. **`numpy/numpy` was refused**: GitHub reports its licence as
`NOASSERTION`, so it never reached the disk, and the corpus was assembled without it rather than
with a note that someone thought it looked permissive. The refusal is in the record:
`docs/experiments/corpus-sources.json` lists, per source, the repository, the commit, the SPDX id,
the licence path, the byte count, and — for the refused one — the reason.

| Source | Licence | Commit | Files | Bytes |
|---|---|---|---|---|
| `rajaram-2005/ragam` (this repository) | first-party | *revision at assembly* | 193 | 3.02 MB |
| `pallets/flask` | BSD-3-Clause | pinned | 175 | 1.12 MB |
| `expressjs/express` | MIT | pinned | 146 | 0.69 MB |
| `psf/requests` | Apache-2.0 | pinned | 67 | 0.59 MB |
| `microsoft/TypeScript` | Apache-2.0 | pinned | 230 | 4.04 MB (capped) |
| `pytest-dev/pytest` | MIT | pinned | 390 | 2.89 MB (capped) |
| `pallets/click` | BSD-3-Clause | pinned | 129 | 1.30 MB |
| `numpy/numpy` | **refused** (`NOASSERTION`) | — | 0 | 0 |

The table in `corpus-sources.json` is the authority; the commits are in it, and the byte counts here
are rounded from it. Caps are per source and are recorded, so "the corpus is 13.65 MB" is a decision
that was made rather than an accident of how large a repository happens to be.

### Held out by source, not merely by document

A split by document makes one claim: **no document is on both sides**. It does not make the stronger
one, because a source that contributes ten documents can contribute nine to training and one to
validation — and then "held out" means "held out mostly". Mini's run holds out two sources **whole**:
`pallets/click` and `psf/requests` contribute 1,897,673 bytes of validation text and **not one byte
of training text**, so 1,010 training files (9,867,102 bytes) and 196 validation files share no
source. The manifest records `heldOutSources` and a per-source summary, and both are inside the
digest the run reports, so the claim travels with the run instead of living in a sentence here.

It is asked for with one flag, and the names are checked against the corpus on disk before a byte is
tokenised: `--validation-sources pallets__click,psf__requests` (the corpus directory names, which are
`<owner>__<repo>`) is how the run in flight was started, and a name that matches no file is an error
rather than an empty hold-out.

The cost is honest too: the validation text is two whole Python projects the model never read, which
is a harder and more variable test than a random tenth of every file — and it is the one a reader
would assume a held-out split already was. `build_manifest` refuses a source name that matches no
file, because a hold-out that silently selects nothing would report training-text perplexity as a
generalisation result.

### The manifest is narrower than the directory

The run was given eight extensions — `.py`, `.pyi`, `.md`, `.rst`, `.txt`, `.js`, `.json`, `.ts` — and
the manifest covers exactly those: **11,764,775 bytes of the 13,651,619 bytes assembled**. The other
1.89 MB sits in the corpus directory and was **not** trained on. For this repository's own
contribution that is the larger half: 1,160,058 of 3,018,919 bytes reached the model, because
`services/core` is written in `.mjs` (1,596,253 bytes, 95 files) and `.mjs` was not on the list; the
web app's `.jsx` and `.css` are outside it too.

That is a decision with a cost rather than an accident, and the record of it is the run's own
`--extensions` argument. A 0.2.0 that wants the core service's JavaScript in the training text reads
`.mjs` as well; it is one flag, and the manifest digest moves with it.

### What the release did and did not keep

The gate ran, released the artifact and wrote the card — and then the bytes were gone. `artifacts/` is
gitignored by policy, which is what "referenced by digest, never redistributed through Git" means, and
that directory is not carried by this workspace either: on 2026-10-16 the weights, the report and the
corpus snapshot were no longer present, and no copy existed anywhere on the machine.

That is worth stating plainly rather than discovering later. `klyvaron-mini-lm@0.1.0` is a **released
artifact whose file is not retained**: the card, the run record and the digests are what remain, and
the run that produced it would have to be repeated to put a loadable file back — with a different
corpus, because of the point below. A family that refuses to assert a capability its data cannot
train should also refuse to imply that a release is still served after its weights have been lost.

### Why 0.1.0's corpus is a record and not a recipe

`assemble_corpus.py` copies this repository's own text **off the working tree**, while the sources
record it wrote named only `git rev-parse HEAD`; every other source comes from a tarball at a pinned
SHA, where the revision really is the bytes. At assembly time 45 paths in this repository were
uncommitted, and each source is truncated at a byte cap in sorted-path order, so the recorded
revision does not describe the bytes that were copied and the file set depends on the tree's shape at
that moment. The manifest digest `f8dfef6f…` is therefore a record of what was read.

The defect is fixed rather than described: `git_state()` marks the revision `-dirty` when the tree
does not match it — the suffix `train.code_revision()` has always written for the code revision — and
the source entry now carries `clean` plus a `treeDigest` over the path and content of every file
copied. `services/fabric/tests/test_corpus_assembly.py` covers it, including that the two definitions
of a dirty revision agree. This record's own copy of the sources file predates the fix, so its
first-party entry names the commit without the suffix.

## 5. The recipe, and which steps are done

Seven steps, in order. `architecture.mjs::recipeReport()` reports each one per size, and the only
step that is satisfied for Pro and Max is the one that is code.

| Step | Lite | Pro / Max | Why it is where it is |
|---|---|---|---|
| `corpus` — licence-checked, manifest digest recorded | done | **open** | This repository's own text is 2.4 MB. That is enough for 359,616 parameters and not enough for tens of millions: the model would memorise it. |
| `tokenizer` — fitted on the training split only | done | **open** | A 148-character vocabulary is the wrong unit at this parameter count; it spends the compute on sequence length instead of on text. A subword tokenizer has to be trained on the corpus first. |
| `config` — the architecture and the exact config, digested | done | **done** | This is the step that needs no compute. The preset is recorded here and hashed (`81ef35d1…` for Mini, `edc4bb93…` for Pro, `bbaa88b5…` for Max). |
| `backend` — a trainer that runs on the target accelerator | done (CPU) | **open** | The trainer is pure NumPy and CPU-only. Running this size on a GPU or NPU is code that does not exist yet — it is the step that turns "train it on your machine" from a sentence into a program. |
| `train` — from random initialisation, steps and loss recorded | done | **open** | No weights exist. A model *is* its weights. |
| `evaluate` — held-out, against a baseline, hard requirements | done | **open** | Nothing to evaluate until weights exist. |
| `release` — model card, digests, weights referenced not redistributed | done | **open** | Nothing to release until weights exist and pass evaluation. |

`mini` is not in that table because it is not a tier, and its seven steps are now all satisfied —
which is what makes it worth having. The corpus is assembled and digested, the tokenizer is fitted
on the training split only, the config is recorded in the preset, the trainer is the same NumPy one
that ran Lite, and `train`, `evaluate` and `release` moved when the run exited and its report
existed. `recipeReport('mini')` prints those evidence strings, and they quote the run's own
digests — a step that reads "training now" would still be open, because a running process is a
status and a report is evidence.

The evaluation requirements are the released card's own, unchanged: perplexity below a bigram
baseline on identical held-out tokens, unknown rate under 2 %, a loss improvement above 1.0 nats,
and the differentiator evaluations from [22](22-klyvaron-differentiation.md) — a stale-source answer
counts as wrong, and the affect reader abstains rather than guessing.

## 6. What training would cost, as arithmetic

Training compute is `6 · N · D` for a dense transformer. At 36 tokens per parameter:

| Size | Tokens | FLOPs | 2 TFLOP/s | 5 TFLOP/s | 20 TFLOP/s | 100 TFLOP/s |
|---|---|---|---|---|---|---|
| Pro (27.5 M) | 1,000,000,000 | 1.65 × 10¹⁷ | 23.0 h | 9.2 h | 2.3 h | 0.5 h |
| Max (92.1 M) | 2,000,000,000 | 1.10 × 10¹⁸ | 153.6 h | 61.4 h | 15.4 h | 3.1 h |

**The rates across the top are assumptions, not measurements.** This host has no accelerator, so it
cannot measure one, and a number read off a spec sheet and printed as throughput would be exactly
the kind of claim this family refuses. `secondsAt()` takes the rate as an argument; `arch --tokens`
prints this table with the assumption labelled. For scale, the same arithmetic at this host's
**measured** fp32 matmul throughput — 0.13–0.16 TFLOP/s for a 4096³ and a 2048³ multiply on two
cores, measured on 2026-10-15 — puts Pro at 290–350 hours and Max at 1,950–2,350 hours. The
trainer's own achieved rate is lower again — the run in flight is at about 9 GFLOP/s, counted as 6ND
over the 400 steps it printed in 757 s — because a training step spends its time in LayerNorm,
GELU and memory traffic rather than in one long matmul. That gap, and not any hyperparameter, is why
the `backend` step matters most.

## 7. The differentiators are parts of the model

Knowing what is current and understanding what the person expressed are not wrappers around this
model. They are inputs the trunk sees at every layer and heads trained in the same loss as the
next-token objective ([`klyvaron/architecture.mjs`](../services/core/src/klyvaron/architecture.mjs)):

| Part | Serves | What it is | Why it is a part rather than a check |
| --- | --- | --- | --- |
| `age_buckets` | `trend.awareness` | a conditioning table: how old the evidence behind each token is | Freshness is a property of the evidence, not of the text. If it is not an input, the model can only guess. |
| `verdict_head` | `trend.awareness` | a head at the last position: *grounded* or *abstain* | Abstention has to be something the model can **do**. A stale source makes abstain the correct class, so a stale answer is an error the loss sees. |
| `state_emb` | `affect.history` | a conditioning table: the state the session carries into the turn | What was expressed earlier is context for this turn. It is a hint and never the label, so the head cannot score by reading its own input. |
| `state_head` | `affect.history` | a head over the expressed states, one class of which is *none* | One reserved class gives the model somewhere to put an abstention instead of being forced to name a state for every message. |

The trainer implements all four: `TransformerConfig` carries `age_buckets`, `state_classes`,
`verdict_head` and `state_head`, and both conditioning tables and both heads are part of one
`loss_and_grads`. Their gradients are checked against central finite differences like every other
parameter, and a config that asks for a head with no classes is refused rather than ignored.

**Measured, on generated data, at 900 steps:** the prototype in
`services/fabric/scripts/lm_differentiator_prototype.py` trained all four parts in one loss — 72,838
parameters, of which 902 are the parts — and scored them on held-out text it had not seen, in 249.3 s
on this host's CPU, with the joint loss falling from 5.3566 to 0.6010 nats. Verdict classification
reached **1.0000** against a 0.5137 majority-class baseline, with abstain recall **1.0000** on the
stale-only split; state classification reached **0.6934** against a 0.2891 baseline, and the reserved
*none* class was recalled on **0.8333** of marker-free text
(`docs/experiments/differentiator-prototype.json`).

What those numbers mean, and what they do not: the parts are wired correctly, they learn, and they
abstain on the cases that call for it. The phrases are generated from a closed list, the age buckets
are drawn from a uniform distribution, and nothing was observed from a real source or a real
message. It is a mechanism prototype, it is not a model artifact, and it does not move either
capability's gate. `no base checkpoint` is not a promise here either: the parts were trained from a
random initialisation of this repository's own model class, exactly like the pretrained base they
sit in.

## 8. Image and video are separate designs

`MODALITY_MODELS` records three models, not one model with three prompts: `aetheris-core-v1` for
text, `aetheris-image-v1` (a latent denoising transformer) and `aetheris-video-v1` (a latent video
transformer). The last two are `implemented: false` with no trainer and no parameter count, because
a number nobody can train is a wish rather than an architecture. The family validator independently
refuses an artifact that backs a text capability and an image or video capability at once
([22 §4](22-klyvaron-differentiation.md)).

## 9. What is claimed, and what is not

* **Not claimed:** that Pro or Max exist. No weights, no artifact, no card, no date. The tier status
  is `unbuilt` and the plan says so gate by gate.
* **Not claimed:** any tokens per second, any peak memory figure, any benchmark comparison. The only
  comparisons this family makes are against its own computed baselines ([22 §1](22-klyvaron-differentiation.md)).
* **Not claimed:** that an architecture is a capability. `trend.awareness` and `affect.history` stay
  `unavailable` at every tier until an artifact is measured against their acceptance rules; the
  mechanisms in `klyvaron/trends.mjs` and `klyvaron/affect.mjs` are wired to the plan, and a
  mechanism is not a model.
* **Claimed, and checkable:** the configuration, the parameter arithmetic, the memory arithmetic, the
  digests, and the recipe with its open steps — all in `klyvaron/architecture.mjs`, all covered by
  `test/architecture.test.mjs`, and all print-able without a GPU.

## Where the code is

* `services/core/src/klyvaron/architecture.mjs` — the architecture, the four presets, the parts in
  §7, the parameter and memory arithmetic, the modality models, the recipe and its per-size status.
* `services/fabric/fabric/lm/model.py` — the trainer's implementation of the parts: the two
  conditioning tables and the two heads, in one loss.
* `services/fabric/scripts/lm_differentiator_prototype.py` — the 900-step prototype that measured
  them, and `docs/experiments/differentiator-prototype.json` is its record.
* `services/fabric/tests/test_lm_model.py` — the finite-difference checks that cover the new arrays,
  and `tests/test_lm_differentiator_prototype.py` — the prototype's contract.
* `services/core/src/klyvaron/composition.mjs` — the path this family does *not* take
  ([23](23-training-free-tiers.md)), kept because the refusal is enforced by a derived gate.
* `services/core/src/klyvaron/plan.mjs` — `own_weights` (met only by a released artifact of this
  family) and `accelerated_runtime`, both derived from the record.
* `services/core/scripts/klyvaron.mjs` — `arch [lite|mini|pro|max|all] [--tokens <n>]`.
* `services/core/test/architecture.test.mjs` — the Lite preset against the released card, the
  preset ordering, the arithmetic, the refusals and the recipe states.
* `services/fabric/fabric/lm/` — the trainer these presets are configured for.

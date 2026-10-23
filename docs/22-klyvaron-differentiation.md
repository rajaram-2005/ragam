# 22 — What the Klyvaron family is for: the present, and the person

**Status, stated first.** Lite exists and is released ([11 — Klyvaron family](11-klyvaron-family.md)).
**Pro and Max have no artifacts and no model has been trained for them.** The two capabilities that
define this family — knowing what is current, and understanding what the user expressed across a
session — are **defined and enforced here and backed by nothing**, so every tier reports them as
`unavailable`. The mechanisms behind them exist in this repository and are tested. A mechanism is not
a model.

This page is the specification the family is built against. `services/core/src/klyvaron/tiers.mjs`
is the same specification in code, and `services/core/src/klyvaron/plan.mjs` derives the gates from
it, so nothing here is a paragraph that can drift away from a record:

```bash
node services/core/scripts/klyvaron.mjs plan
```

## 1. The stance: this family does not compete

A model family that is trying to win a comparison optimises for the comparison. This one is built
for two things instead, and it refuses the third in code:

| Rule | Where it is enforced |
| --- | --- |
| No benchmark win over a named or unnamed competitor is claimed | `FAMILY_STANCE.forbiddenClaims`; `stanceViolations()` scans each tier's own description and status note, and `validateFamily()` refuses a tier that names a vendor |
| No quality improvement is inferred from a tier label, a version number or a parameter count | The capability validator: an `available` claim needs a backing artifact, measurements and stated limitations |
| No feeling or diagnosis the user did not express | `klyvaron/affect.mjs` reports only phrases the user typed, cites the message, and abstains otherwise; `DIAGNOSIS_TERMS` is refused in any generated statement |

Allowed comparisons are the ones this repository can compute itself: a baseline measured on the same
data (uniform, unigram, bigram, dense-only), or an earlier released artifact of this family on the
same metric and workload. That is the comparison the tier records, the model cards and
[06 — Benchmarks](06-benchmarks.md) have always made, and it is the only one this family will make.

The corollary matters for how Lite is described: **Lite is not "our small model".** It is a
359,616-parameter character-level model trained from random initialisation on this repository's own
text at revision `8d9cdf8`, with a perplexity of 4.8932 against a bigram baseline of 15.7588. It
does not chat. Nothing about it is offered as a claim about any other model, and no other model is
named.

## 2. First differentiator: the present (`trend.awareness`)

**What it means.** An answer that depends on a fact which changes states the date the fact was
observed and where it came from, and when the observation is older than the window it was asked
about, the model says so and abstains. "As of 2026-03-11" is an answer; "recently" is not.

**What exists now.** `services/core/src/klyvaron/trends.mjs`: a dated observation ledger with four
refusals, each of which has a test.

| Rule | Behaviour |
| --- | --- |
| No source, no observation | `observe()` refuses a claim without an `http(s)` source URL. An unsourced statement about what is current is a rumour |
| No date, no observation | The observation time is required and may not be in the future. "Recently" is not a date |
| Every observation expires | Each carries a ttl, and a caller passes its own window. Both must hold |
| It abstains | With nothing inside the window it returns `abstained: true` and the age of the newest entry it holds, so an answer given anyway is given over a field that said no |

**It is also a part of the model, not only a check around it.** `aetheris-core-v1` gives every
token an **age bucket** — how old the evidence behind it is — as an input the trunk sees at every
layer, and a **verdict head** that decides *grounded* or *abstain* at the last position. Both are
trained in the same loss as the next-token objective, so abstention is something the model can do
rather than a rule applied to its output afterwards ([24 §6](24-own-models.md)).

**A prototype measured those parts.** The release trainer's own model class, at 900 steps on the
CPU of this host, on generated text with the age bucket drawn from a four-value table whose top two
values are outside the freshness window (`docs/experiments/differentiator-prototype.json`):

| Measurement | Score | Majority-class baseline |
| --- | --- | --- |
| Verdict classification, held-out | **1.0000** | 0.5137 |
| Abstain recall, stale-only sources | **1.0000** | — |
| State classification, held-out | **0.6934** | 0.2891 |
| *none* recalled on marker-free text | **0.8333** | — |

Generated data proves the part is wired, learnable and that its gradients are right. It is not a
model artifact, it is not evidence about real sources, and it does not move the gate.

**What is still missing.** A model artifact trained on real sources, and scores on it. The
capability's `acceptance` list in `tiers.mjs` is the definition of done: every time-sensitive answer
states its observation date and source; a stale-source answer counts as wrong, not as a pass; and a
held-out set of dated questions is scored. Until that exists, the tier record says `unavailable` and
the plan keeps the gate open.

## 3. Second differentiator: the person (`affect.history`)

**What it means.** Across a session — and across the model versions that served it — the assistant
can say what the user expressed, quote the message it came from, and say nothing at all when the
user expressed nothing. It is not a mood detector: a detector reads between the lines, and reading
between the lines about somebody's feelings is how a product starts being wrong about them.

**What exists now.** `services/core/src/klyvaron/affect.mjs`, with six rules that are the code
rather than a policy:

1. **Consent first.** Without an explicit `approvedBy: 'user'` record, the module throws. A session
   is not consent to read it, and an agent cannot grant it — the same rule the memory store's
   schema enforces with `CHECK (approved_by = 'user')`.
2. **The user's own words only.** Assistant messages are never evidence about the user. Otherwise a
   model that says "you sound frustrated" creates the state it then reports.
3. **Cite the message.** Every signal carries the message id, the phrase and the model version that
   served the turn, so a change in behaviour is attributable to a version rather than to the person.
4. **Abstain.** A message with no phrase in the closed list produces no signal and is listed in
   `abstained`. Writing style, punctuation and message length are never read, so a terse message is
   not read as anger.
5. **No diagnosis.** Every state is one of eight ordinary words, and a generated statement
   containing a clinical term is refused rather than softened.
6. **One user, deletable.** Signals are computed from the messages given and never stored; removing
   a message removes its signals by construction, because there is no second copy.

**It is also a part of the model.** The architecture carries the session's state into the trunk as
a **conditioning table** (`state_emb`) and predicts the expressed state with a **state head** whose
classes include one reserved for *nothing was expressed* — an abstention the model is trained to
choose instead of being forced to pick a state for every message. The conditioning input is the
state carried in from earlier turns; it is a hint and never the label, so the head has to read the
text to score ([24 §6](24-own-models.md)).

The same prototype measured it on held-out generated text: state classification **0.6934** against a
0.2891 majority baseline, and **0.8333** recall on marker-free text for the reserved *none* class,
which is the abstention case. Generated phrases are much easier than real messages, and the record
says so in its own limitations.

**What is still missing.** A model artifact and held-out evaluation on real messages, including the
negative cases: a session with no expressed state must score as an abstention, and a report must
never be produced for a user who did not consent. `affect.history` stays `unavailable` until those
scores exist.

## 4. Image and video are different models, not different prompts

A text model answering "describe an image you cannot see" is not an image model, and relabelling a
text checkpoint as one is the same defect as a tier label implying a capability. So the rule is
structural: an artifact is bound to one modality, and a tier's capability may only be `available`
behind an artifact of its own modality. `validateFamily()` refuses a family in which an image or
video capability is backed by the artifact that backs the text capabilities, and
`MODALITY_ROLES` makes "which modality is this capability?" a question with an answer for every
capability the family names.

| Tier | Text | Image | Video | Audio |
| --- | --- | --- | --- | --- |
| Lite | `aetheris-lite-lm-0.1.1` (completion and extraction only) | no artifact; `vision.understand` is `unavailable` | not named at this tier | no artifact; `speech.transcribe` and `speech.synthesize` are `unavailable` |
| Pro | `klyvaron-pro-lm-0.1.0` | `klyvaron-pro-image-0.1.0` | `klyvaron-pro-video-0.1.0` | `klyvaron-pro-voice-0.1.0` |
| Max | `klyvaron-max-lm-0.1.0` | `klyvaron-max-image-0.1.0` | `klyvaron-max-video-0.1.0` | `klyvaron-max-voice-0.1.0` |

Where a modality cell has no artifact (such as Lite image and audio), the capability remains
`unavailable` and the route refuses rather than substituting a text answer.

The architecture record says the same thing in the terms a build needs: `MODALITY_MODELS` names
`aetheris-image-v1` (a patch-latent conditional denoising transformer), `aetheris-video-v1` (a
factorised spatial-temporal video transformer), and `aetheris-voice-v1` (a bidirectional mel/CTC +
neural spectrogram voice transformer) as **separate designs** with their own trainers and checkpoints,
alongside the text architecture `aetheris-core-v1`. They are not configurations of the text model,
and the core refuses an image, video, or audio capability backed by a text preset
([24 §8](24-own-models.md)).

## 5. The tiers

| Tier | Hardware | Status | Backed capabilities | What it would take to move |
| --- | --- | --- | --- | --- |
| **Klyvaron Lite** | CPU-only computers and supported phones | **Partial** | 2 of 13 | An instruction-tuned artifact (chat), a vision or speech artifact where it claims one, and an artifact behind each differentiator |
| **Klyvaron Pro** | GPU-qualified laptops and desktops | **Partial** | 10 of 15 | Full real-world differentiator benchmarks (`trend.awareness`, `affect.history`), GPU accelerator runtime qualification, and open workflow/multilingual capabilities |
| **Klyvaron Max** | Qualified high-performance GPU computers | **Partial** | 10 of 14 | Full real-world differentiator benchmarks (`trend.awareness`, `affect.history`), GPU accelerator runtime qualification, and open workflow/long-horizon capabilities |

Nothing in this repository trains Pro or Max. The path recorded for them needs **no training at
all**: an unmodified, licence-checked third-party base, running on the user's own accelerator
(CUDA, ROCm, Metal, Vulkan or an OpenVINO GPU/NPU), wrapped in the two mechanisms above — and a
real measured run before anything is claimed. That technique, its eight steps and the memory
arithmetic that decides whether it fits are in [23 — Pro and Max without training](23-training-free-tiers.md).
The base never wears the tier label: a label is a lookup in the backings of available
capabilities, and a tier with no artifact has none.

## 6. What is not claimed

* No Pro or Max artifact, no Pro or Max training run, and no date for one.
* No image or video model. `/api/image` and `/api/video` refuse, and no text model is offered in
  their place.
* No model-level trend awareness or affect understanding: both mechanisms are libraries with tests,
  not capabilities with artifacts, and both gates are open at every tier.
* No competitive benchmark result of any kind, and no comparison against another vendor's model.
* No quality claim for Lite beyond its card: perplexity 4.8932 against a bigram baseline of
  15.7588 on its own held-out split, and the stated fact that it does not follow instructions.

## Where the code is

* `services/core/src/klyvaron/tiers.mjs` — the stance, the differentiator capability records with
  their acceptance criteria, `MODALITY_ROLES`, and the validator that refuses a relabelled text
  model or a tier that names a competitor.
* `services/core/src/klyvaron/plan.mjs` — the gates, including `differentiation_stance`,
  `trend_awareness`, `affect_history` and `modality_separation`, all derived from the record.
* `services/core/src/klyvaron/trends.mjs` — dated, sourced observations that expire and abstain.
* `services/core/src/klyvaron/affect.mjs` — consent-gated, evidence-cited states, no diagnosis.
* `services/core/test/klyvaron-differentiation.test.mjs`, `trends.test.mjs`, `affect.test.mjs` —
  the tests behind every claim on this page.

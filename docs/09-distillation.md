# 09 — Distillation

**Two paths. One runs here today without credentials; the other is built, tested against
a fixture, and waiting for a key.**

This document exists because the two are easy to confuse and only one of them could be
exercised in this environment. Nothing below claims a result that was not measured.

---

## 1. Why there are two

Distillation is "a smaller model learns from a larger one", but *how* the smaller one
learns decides what infrastructure it needs.

| | Teacher logits | Teacher text | Runs here? |
|---|---|---|---|
| **Logit distillation** | needed | — | **Yes**, if the teacher's weights are on this machine |
| **Sequence distillation** | not needed | needed | **No** — needs an external provider and a credential |

Logit distillation matches the teacher's full next-token distribution. That requires
the teacher's weights, which rules out any model behind an API — including every
model that lives behind an API. Sequence distillation only needs the teacher's *text*, so
it works across HTTP, at the cost of the teacher's uncertainty: the student sees one
sampled continuation instead of a distribution over all of them.

So the split is forced by the interface, not chosen for convenience.

### The teacher that was already here

The blocker for external distillation is not technique. `api.openai.com`,
`text.pollinations.ai`, `api.openai.com` and `generativelanguage.googleapis.com` are
**all unreachable from this sandbox** (HTTP 000 before credentials are even
considered), and no API key is configured. Nothing in this repository has ever
contacted a real provider.

But logit distillation needs no provider. It needs a teacher whose weights are local —
and `aetheris-lite-lm@0.1.0`, trained in `services/fabric` from random initialisation,
is exactly that. 359,136 parameters, digest `82392ef89074…`, released through the gate
in [`08-aetheris-lite.md`](./08-aetheris-lite.md).

That is the path that produced the result in §5.

---

## 2. Logit distillation: the objective

With temperature `T` and hard-label weight `alpha`:

```
L = alpha · CE(student, hard_label) + (1 − alpha) · T² · KL(teacher_T ‖ student_T)
```

`alpha = 1.0` reduces the objective exactly to plain cross-entropy, which is what makes
the experiment a *configuration* rather than two code paths: both arms call the same
function, and `alpha` is what differs. The baseline does not even forward the teacher,
so it pays no compute for machinery it does not use — asserted by a test that passes a
teacher which raises if it is ever called.

### The gradient

Since the teacher is frozen, differentiating with respect to the student's logits:

```
dL/dz = alpha · (softmax(z) − onehot) / (B·T_len)
      + (1 − alpha) · T · (softmax(z/T) − softmax(z_teacher/T)) / (B·T_len)
```

The `T²` in the loss and the `1/T` from the chain rule through `z/T` leave a single
factor of `T` on the second term. **Getting that factor wrong changes nothing
observable**: no crash, no NaN, no shape error — just a differently-weighted objective
and a student that is quietly worse than it should be. So the whole objective is
checked against a central finite difference on every parameter, the same way the base
model's backward pass is, and a companion test confirms the check can tell the correct
factor from a wrong one.

This is the same reasoning that found a real positional-gradient bug in
`08-aetheris-lite.md` §3. Two objectives, one verified backward pass:
`backward_from_dlogits` was extracted from the original `loss_and_grads` so both share
it, and the extraction was checked directly rather than assumed — the pre-refactor
implementation was loaded from git beside the new one, given byte-identical parameters
and identical inputs, and compared. Same loss, and all 24, 15 and 34 gradients
bit-identical across three configurations, including one with an untied output head.

---

## 3. Sequence distillation: the credentialed path

`fabric/lm/teacher.py` speaks `/v1/chat/completions` to anything OpenAI-compatible.
It takes evenly spaced prefixes of real repository text, asks the
teacher to continue each one, and writes the continuations into a corpus that the
existing trainer consumes as ordinary data.

Three things it enforces rather than documents:

**It refuses without authorization.** Sending repository text to a third party is a
decision that has to be attributable, so every send passes through
`privacy.gate_send`, which needs an `Authorization` naming who approved it and why.
There is no default instance. A gate that passes by default is a formality.

**It redacts credentials regardless of authorization.** Even with permission to send,
a key does not need to leave the machine for the teacher to continue a sentence.
`API_KEY=sk-proj-…` becomes `[REDACTED:openai_style_key]` and the surrounding
paragraph still goes. A test asserts the credential never appears in the bytes the
provider receives.

**It treats model output as untrusted data.** Control characters are stripped, blank
runs collapsed, length bounded. Nothing from a response is interpreted as an
instruction, a path or a command.

### The redactor is a second implementation, so it is pinned

`services/core/src/policy/classify.mjs` is the authority for text leaving through the
application. It is JavaScript; `services/fabric` is Python and cannot import it, and
adding an HTTP classification route purely so a batch script could call it would expose
a new endpoint to solve an offline problem.

So the patterns are mirrored, and the mirror is pinned by a fixture **generated from
the Node implementation**:

```
node services/fabric/scripts/generate-redaction-parity-fixture.mjs \
  > services/fabric/tests/fixtures/redaction-parity.json
```

Fixture generation fails if any pattern declared in `classify.mjs` is not exercised by
at least one probe, and if any probe marked clean is redacted. That is what stops the
Python side quietly missing a pattern while the parity test still passes — the
"passes by omission" failure this project has already hit twice.

**It found a defect on its first run.** `anthropic_style_key` (`sk-ant-…`) was
declared *after* `openai_style_key` (`sk-…`), and patterns are applied in sequence so
the first match consumes the text. Every Anthropic key was therefore reported as an
OpenAI key and the Anthropic pattern could never fire. The credential was still
redacted — nothing failed, which is exactly why it went unnoticed. Fixed by ordering
the specific pattern first, and pinned by a test in `policy.test.mjs` so a future
reorder fails loudly.

---

## 4. What is not implemented

- **No external distillation run has ever been executed.** No key is configured and no
  provider host is reachable, so this path **has never been run against a real
  provider**. It is tested against a local `http.server` fixture, which proves the
  request shape, the header, the parsing and the gate — and proves nothing about any
  real provider's behaviour. Status: **Requires external credentials**.
- **No logit distillation from a model we did not train.** Only
  `aetheris-lite-lm@0.1.0` is available to act as a teacher.
- **No instruction tuning.** The student is a base model, exactly like its teacher.

---

## 5. Results

## 5. Results

Three paired conditions, three seeds each, on the teacher's own corpus snapshot. The
verdicts below were computed by `verdict_for()` from the numbers, not written by hand:
a condition is only called an improvement, or a loss, if it holds on **every** seed and
the mean clears the spread across seeds.

### 5.1 The primary comparison

| | |
|---|---|
| Teacher | `aetheris-lite-lm`, 359,904 parameters, weights `c034a15095fc…` — trained from scratch in 2,600 steps, validation perplexity **4.8359** against a bigram's 16.7474 |
| Student | 67,632 parameters (**5.32× smaller**), same corpus, same tokenizer |
| Objective | temperature 2.0, alpha 0.5 |
| Budget | 300 steps × batch 12 × context 96 = **345,600 tokens seen = 0.17 epochs** of the 2,081,732-token training split |
| Corpus | snapshot `6c81638dd0c9…`, 121 train / 14 validation files |

| seed | baseline nll | distilled nll | gain |
|---|---|---|---|
| 0 | 2.857178 | 2.952825 | −0.095647 |
| 1 | 2.860410 | 2.955126 | −0.094716 |
| 2 | 2.848977 | 2.935233 | −0.086256 |

Mean gain **−0.092206** nats/token, spread across seeds 0.005174, **3 of 3** seeds
reversed, and the mean clears the spread by 18×.

**Verdict: REJECT.** Distillation was worse on every seed, and by far more than the
seed-to-seed variation. The distilled student reaches validation perplexity 19.0626
against the baseline's 17.3835 — **9.66% worse**.

The baseline arm **0 teacher forwards** in every run: at `alpha = 1.0` the teacher is
never called, so the baseline does not pay for machinery it does not use, and the two
arms differ in the objective rather than in effort. The three baseline numbers are
byte-identical across all three runs of the experiment (2.857178 / 2.860410 /
2.848977 in every one), which is what the pairing claims and a useful confirmation
that it holds in practice and not only by construction.

### 5.2 Why it lost

Two diagnostics, both read from the same records.

**The student is not near the regime where this is supposed to work.** At 0.17 epochs
its perplexity is 17.3835, which is *worse than the bigram baseline's* 16.7474. A
student that has not yet learned to beat a two-token lookup table is a student for
which the teacher's soft targets are competing with the signal it still needs.

**The harm scales with how much weight the soft targets are given.**

| Condition | Teacher | alpha | Mean gain | Validation perplexity |
|---|---|---|---|---|
| primary | trained | 0.5 | **−0.092206** | +9.66% |
| sensitivity | trained | 0.9 | **−0.009025** | +0.91% |
| control | **untrained**, same architecture | 0.5 | **−0.310491** | +36.41% |

The third row is the one that makes the other two readable. An untrained teacher of
identical architecture knows nothing, and it does far more damage than the real one —
**3.4×** as much loss. So the machinery is not merely injecting noise, and the trained
teacher's information is real and measurable: under an identical objective it recovers
**0.2183 nats/token** relative to a null teacher. The failure is not that knowledge
did not transfer. It is that what transferred did not repay what it cost.

The control also shows the objective working exactly as written, in a way worth
pinning: its *training* loss falls to 1.6203, far **below** the baseline's 2.5606,
while its validation loss is much worse. That is what fitting a wrong target looks
like — and it is why a training loss under a distilled objective is not comparable to
one under cross-entropy, and is not used as evidence anywhere in this document.

### 5.3 What this does and does not license

It **does** license: *at this scale, on this corpus, at this budget, logit
distillation from a trained teacher does not beat plain cross-entropy, and a null
teacher is measurably worse than a trained one.*

It **does not** license any statement about distillation in general. Unchanged, and
untested here: the temperature, the student size, and above all the budget. 0.17
epochs is not a fair test of a method whose usual benefit is regularisation over many
passes. The obvious next experiment — the same pairing at a budget where the baseline
student beats the bigram — is **not implemented and not run**, and is recorded here as
the next step rather than described as if it had been.

### 5.4 Reproducing it

```bash
cd services/fabric
python scripts/distill_experiment.py \
  --teacher artifacts/<teacher>.npz \
  --corpus-snapshot artifacts/<teacher>.corpus.json \
  --seeds 3 --steps 300 --json verdict.json
```

`--corpus-snapshot` is not optional in practice. The first attempt at this experiment
was **refused** — correctly — because eight characters had entered the repository's
text between training the teacher and running the student, leaving the two with
different vocabularies. The snapshot pins the text the teacher actually saw.

Full records, including every per-run measurement and digest:
[`docs/experiments/`](./experiments/).

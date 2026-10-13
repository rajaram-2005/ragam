# 08 — Aetheris Lite: a language model trained here, from nothing

**Status: implemented, trained, evaluated, and released through the same gate as any
other model card — with its limitations stated on the card rather than in a footnote.**

---

## 1. Why from scratch

Every previous attempt to put a real language model behind `/api/chat` failed for the
same reason: there was no checkpoint to fine-tune with and no way to obtain one.

| Attempt | Result |
|---|---|
| `huggingface.co` | unreachable from this environment |
| `download.pytorch.org` | unreachable |
| `release-assets.githubusercontent.com` | HTTP **000**, host unreachable |
| `gh api repos/karpathy/llama2.c/releases` | **0** releases |
| `pip install llama-cpp-python` | 0.3.36 publishes **no manylinux x86_64 wheel**, for any version |
| `tinyllama` / `llama-models` / `model2vec` on PyPI | reachable, no weights — largest is 6.6 MB of Python |
| `command -v ollama llama-cli llama-server llamafile` | all absent |
| `find / -xdev -name '*.gguf' -o -name '*.safetensors'` | **none** on the host |

Those are the obstacles for *adapting someone else's* model. Training from random
initialisation needs none of them: it needs a corpus, an optimiser, and compute. The
corpus is this repository (1.53 MB of its own text). The compute is 2 CPU cores,
measured at roughly 250 GFLOPS for the matrix shapes a small transformer uses.

So the "new technique" that made this possible was not a modelling trick. It was
noticing that the blocker applied to a path we did not have to take.

---

## 2. What it is, precisely

| | |
|---|---|
| Architecture | decoder-only transformer, pre-LayerNorm, 3 blocks, 4 heads, `d_model` 96, `d_ff` 384 |
| Parameter count | **359,136** (recorded on the card; the exact figure moves with the vocabulary) |
| Tokenisation | character-level, vocabulary fitted on the **training split only** |
| Context | 128 characters, sliding non-overlapping evaluation windows |
| Implementation | `services/fabric/fabric/lm/`, pure NumPy, no PyTorch, no GPU |
| Licence | MIT (first-party weights). No third-party weights are involved. |
| Base checkpoint | **none** — trained from random initialisation |

Nothing above is state of the art, and none of it is presented as such. It is a real
model: real weights, real forward pass, real gradients, real generation.

---

## 3. The technique, stated honestly

There is no novel architecture here, and claiming one would be dishonest. Three
implementation decisions are load-bearing and worth naming:

**1. Every gradient is derived by hand and verified numerically.** A wrong backward
pass does not crash or produce NaNs — it trains a model that learns the wrong thing,
and the only symptom is a number that is worse than it should have been. That is
undetectable by reading code. `tests/test_lm_model.py` therefore checks every
parameter's analytic gradient against a central finite difference, and a companion
test corrupts each gradient deliberately to prove the check can fail.

This was not theoretical. The first run of that check found a real bug: the
positional-embedding gradient scattered using a `(T, B)` layout while the hidden
state is `(B, T)`, so every position received another position's gradient. The
numeric check reported `pos: exceeds tolerance by 1.6e-01 (numeric 1.69e-01, analytic
8.39e-03)` and nothing else. No other test, and no training run, would have shown it.

**2. Weight tying between the input embedding and the output head.** At 143 characters
of vocabulary the embedding is a meaningful fraction of all parameters, and tying is
a genuine improvement rather than a shortcut.

**3. The tokenizer is fitted on training text only, and the cost is measured.** Fitting
it on the whole corpus would let validation characters shape the model's alphabet — a
small leak, but the same class of mistake as selecting a model on its evaluation set,
which this project already had to correct once. So the vocabulary is training-only and
the unknown-character rate on held-out text is *measured* and reported
(`0.000497`, or about 1 character in 2,000).

---

## 4. The pipeline, and which stages exist

The brief specifies `Data Validation → Base Selection → Domain Training → SFT →
Preference Optimization → Distillation → Evaluation → Release`. What is real:

| Stage | Status | Evidence |
|---|---|---|
| Data validation | **Implemented** | Every corpus file hashed into a manifest; split by **file**, so no document is on both sides; the trainer refuses to run if the split ever leaks |
| Base selection | **Not applicable** | There is no base checkpoint — training starts from random initialisation |
| Domain training | **Implemented** | `fabric/lm/train.py`: AdamW with decoupled decay, warmup then cosine, global-norm clipping |
| SFT | **Not implemented** | Needs an instruction corpus that does not exist here |
| Preference optimization | **Not implemented** | Needs preference data, a reward signal and compute that this host does not have |
| Distillation | **Planned, not implemented** | The trainer accepts any token stream, so a teacher-generated corpus is a second data source rather than a rewrite. Requires an authenticated provider. |
| Evaluation | **Implemented** | Held-out perplexity against three computed baselines — see §6 |
| Release | **Implemented** | `fabric/lm/card.py` drives the existing `ModelReleaseManager`: register → validate → release, with rollback |

A stage marked *not implemented* is not simulated. There is no placeholder SFT stage
that returns a plausible number.

---

## 5. Evaluation: why baselines are the whole point

A perplexity on its own cannot be judged. It depends on the vocabulary, the corpus
and the tokenisation, so `8.9` is neither good nor bad until something else is
measured the same way. Every evaluation therefore computes three baselines from the
**same training statistics** and scores them on the **same held-out tokens**:

| Baseline | What it captures |
|---|---|
| `uniform` | nothing — `ln(V)`. The floor. |
| `unigram` | how common each character is; no order at all |
| `bigram` | `P(next \| prev)`. **The one that matters.** |

The verdict is `perplexityVsBigram`, computed rather than asserted. On a small corpus
order-1 statistics are strong, and a transformer that loses to a bigram table has not
paid for itself — so losing is reported as losing, not explained away.

---

## 6. Results

Recorded from the release run `aetheris-lite-lm-82392ef89074`. Every figure below is
reproducible from the command in §8 **against the same corpus**; the corpus manifest
digest, tokenizer digest, configuration digest, code revision and all three seeds are
in the run report and on the model card, which is what makes that possible despite the
input being this repository's own text (see §8).

**Held-out perplexity, against baselines computed from the same training statistics
and scored on the same 165,120 held-out tokens:**

| | Perplexity | Bits/char |
|---|---|---|
| `uniform` (`ln 143`) | 143.0000 | 7.1599 |
| `unigram` | 35.2895 | 5.1414 |
| `bigram` | 15.9109 | 3.9917 |
| **Aetheris Lite LM** | **4.4033** | **2.1386** |

**Verdict: beats the strongest baseline.** `perplexityVsBigram` = **0.276748** — the
model's perplexity is 27.7% of the bigram's, or **3.61× better** than the best
non-neural baseline. The gate requires ≤ 1.0.

| | |
|---|---|
| Parameters | 359,136 |
| Training loss | 4.8380 → 1.2551 |
| Wall time | 2,220.1 s (37 minutes, 2 CPU cores) |
| Peak memory | 157.8 MB |
| Tokens seen during training | 5,324,800 |
| Validation unknown-character rate | 0.000497 |
| Artifact | 1,444,942 bytes |
| Weights digest | `82392ef8907455e56e1cee56bf4a074cb9337dc38f79775859b67efa5b822e94` |
| Model card | [`model-cards/aetheris-lite-lm-0.1.0.md`](./model-cards/aetheris-lite-lm-0.1.0.md) · [`json`](./model-cards/aetheris-lite-lm-0.1.0.json) |
| Correlation evidence | `perplexityVsBigram` 0.276748 ≤ 1.0 (hard) · `validationUnknownRate` 0.000497 ≤ 0.02 (hard) · `lossImprovement` 3.582929 ≥ 1.0 (hard) · 0 hard failures, 0 soft failures |
| **Gate result** | **RELEASED** |

**Greedy sample (temperature 0):**

```
server the control and the control limits in detail. Sentence 3 describes the
contactor and thermal limits in detail. Se
```

That is genuinely what a 359K-parameter character model trained on 1.4 MB of source
code for 37 minutes on two CPU cores produces. It is shaped like the corpus and it is
not meaningful. Sampled output at temperature 0.8 is visibly less coherent still.

**What this number is not.** It is not a language-modelling result in any competitive
sense. The corpus is 1.4 MB of this repository's own text, the vocabulary is 143
characters, and the comparison is against baselines computed from the same data — not
against any pretrained model, none of which could be obtained here. The claim being
supported is narrow and exact: **the pipeline runs, the gradients are correct, and the
result is reproducible from the recorded inputs.**

Additionally, the baselines are what make the number interpretable at all. `4.40`
alone is neither good nor bad until the bigram's `15.91` is beside it, measured
identically.


---

## 7. The release gate

The card is produced by `fabric/lm/card.py` and pushed through the existing
`ModelReleaseManager`, which already provided versioning, validation and rollback and
is tested independently. Duplicating that machinery would have been exactly the
duplication this project forbids; what the new module adds is the *policy*.

| Requirement | Threshold | Type |
|---|---|---|
| `perplexityVsBigram` | ≤ 1.0 | **hard** |
| `validationUnknownRate` | ≤ 0.02 | **hard** |
| `lossImprovement` | ≥ 1.0 | **hard** |
| `parameterCount` | ≤ 5,000,000 | soft — a limitation, not a gate |
| `wallSeconds` | ≤ 3,600 | soft |

Two of these deserve their reasoning stated:

- **`perplexityVsBigram`, not perplexity.** An absolute perplexity threshold would be
  arbitrary and would not survive a corpus change. The comparison is what carries
  meaning.
- **`validationUnknownRate`.** If the tokenizer cannot represent the held-out text,
  the perplexity is partly a measurement of `<unk>` and does not describe language
  modelling. A metric that does not measure what it claims must not be releasable.

The rejection path is tested more thoroughly than the acceptance path, because a gate
that has never been observed to refuse something is a gate nobody has evidence for.
`tests/test_lm_card.py` constructs reports that lose to the bigram, that fail to learn,
and that have a broken tokenizer, and asserts each is recorded as **REJECTED** with
its reasons and does not become the live release.

---

## 8. Reproducing it

```bash
# Full release configuration: measured at 37 minutes on 2 CPU cores, no GPU
npm run lm:train

# 60-step smoke run, seconds, to check the pipeline end to end
npm run lm:quick

# The tests for the model, the data split, the evaluation and the gate
cd services/fabric && pytest -q tests/test_lm_*.py
```

The artifact and its report land in `services/fabric/artifacts/`, which is
**gitignored by policy**: weights are referenced by digest from a model card and never
redistributed through this repository. The report JSON next to it carries the corpus
manifest digest, tokenizer digest, configuration digest, code revision, all three
seeds, wall time, peak memory, the loss curve, the evaluation against every baseline,
and the artifact's content hash.

Re-running an identical command produces a **bit-identical** artifact;
`tests/test_lm_train.py::test_the_same_run_twice_produces_the_same_artifact` asserts
exactly that, on the weight bytes rather than on the loss. A differently-seeded run
produces different weights — also asserted, because reproducibility would be
meaningless if the seed did nothing.

Both of those hold **for a fixed corpus, and the corpus is this repository**. The
release figures are therefore reproducible against the release's corpus (manifest
`c3572933…`) and not against a tree that has moved on since. That is measured rather
than asserted: an independent run of the identical configuration on the tree at
`67cdd58` produced a different model, and could not have done otherwise — corpus
manifest `264a436c…`, vocabulary 147 characters instead of 143, **359,520** parameters
instead of 359,136, weights digest `f935f044fe81…` instead of `82392ef89074…`. It still
passed the release gate (perplexity **5.3585** against the bigram's **16.7151**, ratio
**0.320578**, 0 hard failures, 0 soft failures).

Its perplexity is *not* comparable with the release's 4.4033 and is not offered as an
improvement or a regression: the same 5,324,800-token budget (2,600 steps × 16 × 128)
was spent on a corpus about **1.8× larger** (2,614,740 bytes against the release's
1,431,417), so the run made about 2.2 passes over its training text. Held-out perplexity
is a function of the corpus and the vocabulary, and both moved. Every run writes its exact corpus next to its weights
(`<run>.corpus.json`, digest recorded in the report) for exactly this reason, and
`train(..., expect_manifest_digest=…)` turns silent drift into a refusal rather than a
surprise. The whole record of that run — report figures, gate verdict, install and serve
evidence — is committed at
[`experiments/lm-verification-run-67cdd58.json`](./experiments/lm-verification-run-67cdd58.json).

That record's `codeRevision` reads `67cdd58…-dirty`, because the revision used to be read
when the report was written — thirty-five minutes after the corpus was read — and the
working tree was dirty by then. The suffix described the tree, not the corpus: exporting
`67cdd58` and rebuilding the manifest from its text reproduces `264a436c…` exactly, 152
train and 17 validation files. The ordering is fixed in `c621bf8`, which reads the
revision beside the corpus, so the pair cannot be recorded apart again.

### A second run, on a clean revision

That run's corpus contained this project's own build products, because `artifacts/` was
missing from the list of directories discovery skips — so a model was training on the
previous model's report. One line of the exclude list fixed it, and the run was repeated
on the tree at `8d9cdf8` with the fix in place. It is the stronger of the two runs, because
its corpus can be rebuilt from a commit:

| | |
|---|---|
| Revision | `8d9cdf8…`, **no `-dirty` suffix** — the revision is read beside the corpus |
| Corpus manifest digest | `70c5b78c…` — recomputed from that revision's own text before the run finished, so the match is a prediction that held rather than a check fitted to the answer |
| Corpus | 154 train / 17 validation files, 2,614,740 bytes, vocabulary 148 characters (147 in the training text) |
| Parameters | **359,616** |
| Validation perplexity | **4.8932**, against a bigram baseline of **15.7588** on the same 280,192 held-out tokens — ratio **0.310505** |
| Gate | **released**, 0 hard failures, 0 soft failures |
| Wall time / peak memory | 2,062.9 s, 165.2 MB |
| Artifact | `aetheris-lite-lm-53ae59b2a777.npz`, 1,446,862 bytes, weights digest `53ae59b2a777…` |
| Record | [`experiments/lm-verification-run-8d9cdf8.json`](./experiments/lm-verification-run-8d9cdf8.json) |

The perplexity is **not** comparable with the release's 4.4033 and is offered as neither an
improvement nor a regression: the same 5,324,800-token budget was spent on a corpus **1.849×**
larger with a larger vocabulary — about **2.25 passes** over the training text. What carried
over is the configuration and the gate.

Measured the same way, from the operator CLI and the HTTP surface rather than through the
store's API:

| | |
|---|---|
| Install | `scripts/klyvaron.mjs install <dir>` — manifest plus weights, **1,451,765 bytes**, verified before the copy and again after it |
| Device throughput | 22.6 ms to load, **26.2 tokens/s**, 72.9 MB resident |
| NumPy vs JavaScript | all 148 logits for one prompt, maximum difference **1.6e-05**; 24 greedy tokens identical from both (`" a corpus a the comparis"`) |
| `/api/chat`, not pinned | **501** `model_not_instruction_tuned`; pinned, **200** with 48 tokens, `sentExternally: false`, 24.2 tokens/s |
| `/api/storage` | 1.5 MB used, `withinBudget: true`, 4,998,548,235 bytes of headroom |

Both runs remain **verification artifacts**: `aetheris-lite-lm@0.1.0` is the released model,
and neither run is presented as better than it.

---

## 8b. From checkpoint to a model the core can run

A `.npz` and a report are not an artifact. `services/fabric/fabric/lm/export.py` turns a
run into one, and `services/core/src/klyvaron/format.mjs` reads it without a Python
process anywhere near the device:

| | |
|---|---|
| Manifest | `<id>.klyvaron.json` — architecture, vocabulary, digests, provenance, measurements, limitations |
| Weights | the `.npz` itself, parsed in the core (ZIP + `.npy`), with the manifest's SHA-256 re-checked before a byte is used |
| Vocabulary digest | one specification implemented in both languages, checked by running the JavaScript implementation from the Python test suite. The run report records a *different* function over the same character set (`CharacterTokenizer.digest`); the two are not expected to agree, and both are recorded |
| Cross-language parity | a committed fixture carries the exact weights, the NumPy logits and the greedy continuation; `klyvaron-runtime.test.mjs` asserts the JavaScript agrees |

```
python services/fabric/scripts/export_lm.py --from-run services/fabric/artifacts \
    --id aetheris-lite-lm --version 0.1.0 --output <dir>
python services/fabric/scripts/export_lm.py --verify <dir>
```

Putting it on a device is `services/core/scripts/klyvaron.mjs`, which is a wrapper over
the store rather than a second install path — it takes the same four gates, so a scripted
install cannot skip one:

```bash
node services/core/scripts/klyvaron.mjs install <artifact-dir>   # verify, budget, copy, re-verify, record
node services/core/scripts/klyvaron.mjs list
node services/core/scripts/klyvaron.mjs verify [<artifact-id>]
node services/core/scripts/klyvaron.mjs status                   # what the app reports, no server needed
node services/core/scripts/klyvaron.mjs remove <artifact-id> --yes
```

The library holds **one artifact per id**. Updating a model is `install <dir> --replace`, and
the store keeps no copy of what it replaced — so an on-device rollback is the same command
with the previous artifact, which is why the operator has to retain it. That was exercised
with two artifacts whose weights genuinely differ (the `67cdd58` run, `2840150f…`, and the
`8d9cdf8` run, `165e150f…`), under one id:

| Step | Result |
|---|---|
| install `0.1.0-verify` | 1,451,373 bytes, weights `2840150f…`, verified |
| install `0.1.1-verify` without `--replace` | refused (`already_installed`); the library is unchanged |
| install `0.1.1-verify` with `--replace` | all four gates re-run; weights `165e150f…` |
| roll back to `0.1.0-verify` with `--replace` | weights `2840150f…` again, 1,451,373 bytes |
| a copy corrupted by one flipped byte, same size | refused (`digest_mismatch`, both hashes printed); the installed artifact is left alone |

**That exercise found a real defect**, which is the reason it is described here rather than
summarised as a passing test. The first version of it ended with the library holding
**2,898,235 bytes for one artifact id**: `cpSync` merges into an existing directory, so
replacing a version left the previous version's 1.4 MB `.npz` behind with no manifest
referring to it — invisible to `verify()`, never reclaimed, and reported as the source
directory's size rather than the device's. `store.mjs` now clears the artifact's own
directory when it replaces, charges the budget the growth rather than the whole artifact
again, and reports the size it measured on disk; `klyvaron-store.test.mjs` covers a
version-to-version replace and **fails against the old code**. The same sequence now ends at
1,451,373 bytes.

`remove` refuses without `--yes` and prints what it would delete: a model the user asked
for is user data, and a cleanup that silently drops it is not a cleanup.

The runtime is `services/core/src/klyvaron/runtime.mjs`: the same pre-LayerNorm
transformer, the same parameter names, the same order of operations, in plain
JavaScript. It is not a second model and it is deliberately not an approximation — the
point of the parity fixture is that a divergence in an activation, an attention scale or
the output projection fails a test instead of silently producing worse text.

Two things it does **not** do, both for honesty rather than effort: there is no KV cache
(each token re-runs the 128-token window, exactly like the reference) and no
quantisation (shipping int8 without measuring its effect on this model's perplexity would
be a quality claim with nothing behind it).

### Measured on a full-size artifact, not only on the fixture

The parity fixture is deliberately tiny. The same checks were then run against the
359,520-parameter verification artifact — a model 57× its size — because a parity claim
that holds at 6,264 parameters and nowhere else is not a parity claim:

| | |
|---|---|
| NumPy vs JavaScript logits, all 147 of them, same prompt | maximum absolute difference **8.2e-06** (the fixture test's tolerance is 1e-3) |
| Greedy continuation, 24 tokens, temperature 0 | the **same string** from both implementations (`" not a contactor and the"`) |
| Vocabulary digest | the manifest's digest is the export specification and the JavaScript reproduces it exactly; the run report's separate `CharacterTokenizer.digest` is also reproduced, by Python |
| Install | `KlyvaronStore.install()` — verified before copying, budget-checked, re-verified after, digest recorded: 1,451,373 bytes |
| `/api/ready` | model loaded, `capabilities.chat` **false**, `textCompletion` **true** |
| `/api/chat`, not pinned | **501** `model_not_instruction_tuned`, with the artifact's own four limitations attached |
| `/api/chat`, pinned to `klyvaron:aetheris-lite-lm-verify` | **200**, 48 tokens, `sentExternally: false`, and the text labelled as a continuation rather than an answer |
| `/api/chat/stream`, pinned | **200**, `route` / `delta` / `done` events |
| Load and generate, in JavaScript, no Python and no GPU | **23–27 ms** to load; **24–26 tokens/s**; 72–81 MB resident |
| The manifest's generation ceiling | honoured: a request for 128 tokens returns the 64 the manifest allows |

The run behind those numbers, including its corpus manifest digest and gate verdict:
[`experiments/lm-verification-run-67cdd58.json`](./experiments/lm-verification-run-67cdd58.json).
It is a verification artifact, not a second release: `aetheris-lite-lm@0.1.0` remains the
released model, and nothing here claims the verification model is better than it.

## 9. Limitations

Stated on the model card itself, not only here. This list is generated by
`limitations_from_report()` so it cannot be forgotten when a card is produced.

- **Output quality is low.** 359K parameters trained for 2,600 steps produces text
  shaped like the corpus and mostly meaningless. This proves the pipeline, not the
  model.
- **Character-level, not subword.** Sequences are long for the parameter count.
- **No world knowledge, no instruction-following, no safety behaviour.** It is a
  base model trained to predict the next character of repository text.
- **Cannot be exposed as a chat assistant in this state.** It *is* wired into
  `/api/chat`, and that is the point: the request is refused with
  `model_not_instruction_tuned` (501) unless the model is pinned by id, and the
  refusal carries this list. Answering a question with it would misrepresent it.
- **No comparison against any pretrained model** was performed and none is claimed.
  The comparison is against uniform, unigram and bigram baselines on in-distribution
  held-out text.
- **The corpus is this repository**, so the model is trained on the documentation that
  describes it. That is harmless for a pipeline demonstration and should not be
  mistaken for a general-purpose corpus.

What *is* established is that the full path — data validation, disjoint splitting,
tokenisation, a hand-derived backward pass, an optimiser, held-out evaluation with
honest baselines, versioned release, and a gate that refuses — runs end to end on
conventional hardware with no external dependency.

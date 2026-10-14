# CPU-first Lite: evaluated int8 artifact support

## What is implemented

Core can now load **weight-only symmetric int8** Klyvaron artifacts and produce
real local completions using the existing zero-dependency JavaScript CPU runtime.
No CUDA, GPU, Python inference server, downloads or company GPU is required.

This is a deployment-format/runtime improvement, **not a useful assistant release**.
The existing released model remains a float32 base completion model. Conversion
does not make it instruction-tuned, improve its reasoning, confer a family tier,
or remove its limitations. The new committed weights are only a small,
random-initialized numerical-parity fixture.

### Artifact contract

- Float artifacts retain `klyvaron.artifact/1`; existing releases remain readable.
- Quantized artifacts use `klyvaron.artifact/2` and
  `weights.quantization = {scheme: "symmetric-int8-per-tensor", scaleDtype: "float32"}`.
- **Every matrix**, including embeddings, positions, attention/MLP projections and
  an untied output head, is an int8 array in `[-127,127]`.
- Each matrix has a one-element float32 NPZ array `<parameter>.scale`.
  Scales are covered by the **same SHA-256 as the weight bytes**, not unhashed JSON
  side metadata. Zero matrices have scale 1. Non-finite, non-positive, overflowing,
  missing or mismatched scales are refused.
- Normalization gains/biases and activations stay float32. The inference kernels
  multiply quantized values by their scales as needed; they do **not** retain a
  second, fully dequantized model. This is not a SIMD/int8 arithmetic speed claim.
- Logical learned-parameter names/counts exclude the scale arrays. Extra archive
  entries, unsupported dtypes, duplicate members and invalid shapes are rejected.

The loader now checks available memory for the archive/expanded members/typed
arrays, bounds decompression before allocation, checks the file size before
reading, and rejects unsafe weight filenames. Installation uses the same checks.
The existing per-forward-pass memory checks and context reduction still apply.
Allocation envelopes are safety bounds, not benchmark-derived hardware minimums.

## Evaluated conversion

Run the converter in Fabric's designated development/evaluation environment,
not in an end-user inference session. Only NumPy is needed. Source must be a
verified **float32 v1** artifact; repeated quantization and unsupported dtypes are
refused. The converter does no training and makes no network request.

```bash
# From the repository root; use your NumPy-enabled Python environment.
PY="${AETHERIS_PYTHON:-python3}"
"$PY" services/fabric/scripts/quantize_lm.py \
  --source services/fabric/artifacts/lite \
  --output services/fabric/artifacts/lite-int8 \
  --version 0.1.1-int8-candidate \
  --validation-text /path/to/representative-held-out.txt \
  --max-nll-increase 0.02 \
  --max-disagreement 0.05 \
  --max-unknown-rate 0.01 \
  --max-tokens 4096 \
  --report services/fabric/artifacts/int8-evaluation.json
```

The example thresholds are operator-chosen **evaluation settings**, not universal
quality guarantees or release standards. Select them for the actual model/task.
Use a disjoint, representative validation set: the tool records full/prefix text
hashes and unknown rate, but cannot establish training-set independence on its own.
Reports contain no raw validation text.

The comparison measures source and quantized next-token cross entropy in nats,
perplexity ratio, teacher-forced greedy disagreement, maximum logit error, number
of evaluated tokens, NPZ bytes and resident **weight payload** bytes. It compares
both models on identical non-overlapping context windows; it does not measure
free-running conversation quality. The NumPy reference reconstructs float32 arrays
for offline evaluation only, unlike the compressed on-device runtime.

Publication requires all supplied quality thresholds to pass **and** both NPZ
and weight payload storage to shrink. A refusal returns exit code 1 and retains
the evaluation report without publishing an installable candidate. Invalid inputs
return 2. Existing output directories and report files are refused. Failed
experiments are not erased or relabelled as successes.

An accepted candidate gets a distinct `-int8` artifact id, an explicit version,
source artifact/manifest digests, preserved licence/instruction status/limitations,
and its own evaluation. Original benchmark claims move to provenance rather than
being presented as measurements of the changed weights. The ordinary family
ownership checks do not automatically grant the candidate a released Lite label.

```bash
"$PY" services/fabric/scripts/export_lm.py --verify services/fabric/artifacts/lite-int8
node services/core/scripts/klyvaron.mjs install services/fabric/artifacts/lite-int8
node services/core/scripts/klyvaron.mjs status
```

Pin a base completion candidate explicitly by its `klyvaron:<id>` model id; ordinary
chat still refuses it as `model_not_instruction_tuned`. API descriptors report the
actual quantization scheme and weight payload bytes rather than claiming float32.

## Repeatable CPU measurement

```bash
node --expose-gc services/core/scripts/benchmark-klyvaron.mjs \
  services/fabric/artifacts/lite-int8 /path/to/prompt.txt \
  --iterations 7 --tokens 16 > /path/to/cpu-int8-benchmark.json
```

Measure the source artifact in a **separate process** with the same prompt and
settings. The report records artifact/runtime/loader digests, architecture, host
CPU/OS/Node version, load time, cold and warm generation samples, actual token and
context counts, median throughput, GC availability and process memory observations.
Prompts are hashed, not saved in the report. Process RSS includes Node/imports,
allocation scratch and object overhead; weight-array/scale payload bytes do not.
No throughput threshold or GPU-tier qualification is inferred from this command.

### Recorded smoke result (not a release benchmark)

[`experiments/int8-runtime-verification.json`](./experiments/int8-runtime-verification.json)
contains both raw CPU runs and the converter report, using the committed random
parity fixture. On that fixture:

| Measurement | Float32 source | Int8 candidate |
|---|---:|---:|
| Weight/scale payload bytes | 25,056 | 6,728 |
| NPZ file bytes | 28,518 | 12,214 |
| Evaluated next-token NLL | 3.446374 | 3.446637 |

This is about **73% less weight payload**, not 73% less process RAM. The recorded
int8 warm throughput was lower than float32 on this tiny workload; no speedup is
claimed. Results cannot be extrapolated to larger models, battery life or mobile
support. The fixture generator and both benchmark commands are recorded in the
JSON; all model bytes remain test fixtures or gitignored artifacts.

To recreate the input directories used by that report, materialize the committed
fixtures (this does not train anything):

```python
import base64, json
from pathlib import Path
root = Path('services/fabric/artifacts/int8-verification')
for label, file in [('float32', 'klyvaron-lite-parity.json'),
                    ('int8', 'klyvaron-lite-int8-parity.json')]:
    fixture = json.loads((Path('services/core/test/fixtures') / file).read_text())
    directory = root / label
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'model.klyvaron.json').write_text(json.dumps(fixture['manifest']))
    (directory / fixture['manifest']['weights']['file']).write_bytes(
        base64.b64decode(fixture['npzBase64']))
(root / 'prompt.txt').write_text('Aetheris Klyvaron ')
```

## Verification and remaining work

- `klyvaron-quantized.test.mjs`: CPU logits/greedy parity against NumPy, resident
  int8 arrays, memory/ZIP limits, invalid scales/dtypes, installation, local and
  streamed completion, honest model labels, and executable benchmark reporting.
- `test_lm_quantize.py`: deterministic conversion, zero tensors, error bounds,
  quality/unknown-rate refusal, provenance, tampering, no-overwrite behavior,
  independent fixture rechecks, CLI reports and untied heads.
- Rebuild the fixture with
  `python services/fabric/scripts/generate-int8-fixture.py`. Its source is the
  existing float32 parity fixture; no licensed production weights are committed.

Still required: suitable licensed instruction-tuned weights, end-to-end assistant
quality evaluation, optimized CPU kernels where beneficial, measurements on real
target devices, native Android/iOS packaging and complete mobile storage gates.
Pro/Max adapters and benchmark-qualified GPU profiles remain separate unfinished
work. This milestone does not mark those capabilities available.

## Execution follow-up

[15 — Responsive local execution](./15-responsive-local-execution.md) adds a
worker-backed app path with incremental delivery, cancellation and lazy model
residency after startup verification. The CPU measurements above remain historical
standalone synchronous-runtime measurements, not worker/HTTP benchmarks.

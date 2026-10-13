# 04 — Setup

Every command below was run on the host described in
[`03-status.md`](./03-status.md). Nothing here is aspirational.

---

## 1. Requirements

| Component | Needs | Verified with |
|---|---|---|
| `services/core` | **Node ≥ 22.5.0** (for `node:sqlite`). Zero npm dependencies | Node v22.22.3 |
| `services/fabric` | **Python ≥ 3.11** + **NumPy** | Python 3.11.2, NumPy 2.1.3 |
| `apps/web` | Node ≥ 20.19 or ≥ 22.12 and npm (for Vite 8). 2 runtime packages, 23 installed in total | Vite 8.3.4, React 18.3.1 |
| Tests | `pytest` for Fabric; nothing extra for core or web | pytest 9.1.1 |

No GPU is required for anything in this repository. No model weights are
downloaded, and none are needed to run the platform — see §7 for what that means
in practice.

> **Do not `pip install torch`.** Nothing here imports it. On a GPU-less host pip
> resolves torch to the CUDA build and pulls several gigabytes of runtime that
> cannot be used. This happened during the audit and had to be unwound.
> `services/fabric` is deliberately NumPy-only.

---

## 2. Quick start

```bash
git clone https://github.com/rajaram-2005/ragam.git aetheris-omni
cd aetheris-omni

cp .env.example .env                    # optional — every value has a default

# 1. the core service (Node, no install step)
node services/core/src/server.mjs

# 2. the web app (separate terminal)
cd apps/web && npm install && npm run dev
```

Open the URL Vite prints. It proxies `/api` to the core service, so the browser
never needs to know where the backend lives.

Expected startup banner from the core, on a host with no model installed:

```
aetheris-core listening
  url           http://0.0.0.0:8790
  policy        strict_offline
  readiness     degraded
  local models  0 ready
  network       external egress is blocked at the fetch layer
  provider      ollama: not_installed
  limitation    no local chat model is installed; /api/chat will return no_model_available
  limitation    no video generation model is available; /api/video will refuse rather than
                substitute a still image
```

`degraded` with those two limitations **is the correct output** on a machine with
no model. It is not an error, and the interface does not soften it.

---

## 3. Running the three components

### Core service

```bash
node services/core/src/server.mjs
# or
npm run core
```

| Variable | Default | Purpose |
|---|---|---|
| `AETHERIS_CORE_HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` for a single-user machine |
| `AETHERIS_CORE_PORT` | `8790` | |
| `AETHERIS_DATA_DIR` | `./.aetheris-data` | SQLite files, media artifacts, audit ledger |
| `AETHERIS_RUNTIME_POLICY` | `strict_offline` | `strict_offline` \| `hybrid` \| `online_enabled` |
| `AETHERIS_ALLOWED_ORIGIN` | *(empty)* | CORS. Empty means same-origin only |

The full variable list, with the semantics of each, is in
[`.env.example`](../.env.example) — that file is the reference, and every value in
it is a real default read out of `services/core/src/config.mjs`.

### Web app

```bash
cd apps/web
npm install          # 62 packages, ~12 s
npm run dev          # dev server with HMR
npm run build        # production bundle into dist/
npm run preview      # serve the built bundle
npm test             # 67 tests
```

| Variable | Default | Purpose |
|---|---|---|
| `WEB_PORT` | `5173` | Dev/preview server port |
| `AETHERIS_CORE_URL` | `http://127.0.0.1:8790` | **Proxy target only.** Node-side; never reaches the browser |

The dev server binds `0.0.0.0` with `allowedHosts: true` so it works behind a
container port-forward or a preview proxy. Browser-facing code uses relative
`/api` paths exclusively; `apps/web/test/api.test.mjs` fails if any absolute host
appears in `src/`.

**Production:** `npm run build`, then serve `dist/` from anything that can also
proxy `/api` to the core service (nginx, Caddy, or the core itself behind a
reverse proxy). No absolute backend URL is baked into the bundle, so the same
build works against any origin that proxies `/api`.

### Fabric service

```bash
cd services/fabric
python3 -m venv .venv && . .venv/bin/activate
pip install numpy pytest
python -m fabric.server          # http://127.0.0.1:8791
```

| Variable | Default | Purpose |
|---|---|---|
| `AETHERIS_FABRIC_HOST` | **`127.0.0.1`** | Loopback by default: this service performs **no authentication**, so a wider bind must be deliberate. Binding elsewhere prints a warning |
| `AETHERIS_FABRIC_PORT` | `8791` | |
| `AETHERIS_FABRIC_DATA_DIR` | *(in memory)* | Where to persist run records and weights |

Fabric is **optional**. The core service does not depend on it; with
`AETHERIS_FABRIC_ENABLED=false` (the default) nothing changes about Chat, Image,
Video, Plugins or MCP.

Startup output states plainly which stages can run on this host:

```
aetheris-fabric listening
  status    degraded (5/8 stages runnable here)
  blocked   sft: supervised fine-tuning needs a base language model and its weights
  blocked   preference_optimization: no preference data, no reward signal and no compute to justify it
  blocked   distillation: distillation needs a teacher model, and no teacher is installed
```

---

## 3b. Training Aetheris Lite

The language model is trained here, from random initialisation, with no downloads:

```bash
npm run lm:quick   # 60 steps, seconds — proves the pipeline end to end
npm run lm:train   # the release configuration, ~55 minutes on 2 CPU cores
```

Both write to `services/fabric/artifacts/`, which is **gitignored by policy**:
weights are referenced by digest from a model card and never redistributed through
this repository. Each run also writes a report JSON carrying the corpus manifest
digest, tokenizer digest, configuration digest, code revision, all three seeds, wall
time, peak memory, the loss curve, and the evaluation against every baseline.

Re-running an identical command produces a **bit-identical** artifact. To train on a
different corpus, pass `--corpus-root`; the split is by whole file, so no document
can appear on both sides of it.

```bash
cd services/fabric
python scripts/train_lm.py --steps 2600 --d-model 96 --n-layers 3 --corpus-root /path/to/text
```

Full design, evaluation methodology and limitations:
[`08-aetheris-lite.md`](./08-aetheris-lite.md).

---

## 4. Tests

```bash
npm test                  # all three suites (1015 tests)
npm run test:core         # 420
npm run test:web          # 67
npm run test:fabric       # 528 — needs numpy + pytest on the interpreter
```

If NumPy and pytest live in a virtualenv rather than on the system interpreter,
point the Python scripts at it:

```bash
AETHERIS_PYTHON=/path/to/venv/bin/python npm run test:fabric
```

Without that, `npm run test:fabric` fails with `No module named pytest` — which is
the correct failure, not a broken test.

Individual suites:

```bash
cd services/core && node --test test/offline.test.mjs     # egress enforcement
cd services/core && node --test test/builtins.test.mjs    # built-in plugins + MCP
cd services/fabric && pytest tests/test_dual_encoder.py -q  # gradient checks
cd apps/web && node --test test/structure.test.mjs        # five-areas invariant
```

`services/fabric` needs **no** Node installation to test: the Node↔Python
tokeniser-parity fixture (`tests/fixtures/text-parity.json`) is committed. It is
regenerated with `node scripts/generate-parity-fixture.mjs` when the Node
tokeniser changes.

---

## 5. Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and `arena/**`, and on every
pull request against `main`. Four jobs, split so a failure names the component that
broke instead of surfacing as one red check:

Four jobs run on every push to `main` or `arena/**`, on every pull request against
`main`, and **weekly on Mondays at 04:17 UTC**. The scheduled run exists because the
advisory gates below check against databases that change continuously: a commit that
was clean when it merged can become vulnerable later, and a trigger that only fires
when something else changes would not notice.

| Job | What it proves |
|---|---|
| **Core service** | 420 tests pass, `services/core` still declares **zero** dependencies, and no `services/core/node_modules` exists. That property is load-bearing: it is what keeps the core auditable and free of a supply chain |
| **Fabric** | 528 tests pass; `torch` is **not** importable; the release gate is exercised end to end in both directions; and `scripts/audit_python_deps.py` checks numpy and the test tooling against the GitHub Advisory Database, failing on a covered version **and** on being unable to reach the database |
| **Web app** | `npm ci`, 67 tests, **two `npm audit` gates** (production clean at every severity; full tree failing on high/critical), production build, then a scan of the built artifact for an absolute loopback backend URL and for credential-shaped strings |
| **Docs** | The 28-test documentation-accuracy suite, checked out with full history because it asserts the model card records a real git SHA and was re-verified at a *different* revision; plus a check that the four licence copies are present and untruncated |

The Fabric job's release-gate step is the one worth reading, because it asserts the
negative case as well as the positive one:

```python
assert record.status == "partial"          # 3 of 8 stages cannot run here
assert card.base_checkpoint is None        # trained from scratch, not a fine-tune
assert card.metrics["mrr"] >= 0.60         # clears the release floor

weak = Pipeline(PipelineConfig(epochs=3, evaluate_topic_split=False))
assert weak.run().status == "failed"       # undertrained must fail
assert weak.registry.current() is None     # and must NOT become the released model
```

Without the last two lines the job would pass even if the release gate stopped
refusing junk — which is the failure mode that matters.

Both bundle regexes were verified against planted secrets before being committed,
because a grep that cannot match anything is worse than no grep.

Nothing in CI installs torch.

---

## 6. Training a model

```bash
npm run train            # in-process; prints "partial run-<id>"
npm run fabric:run       # through the HTTP service (start `npm run fabric` first)
```

`partial` is the expected status: 3 of 8 stages are blocked on this host. The run
record lists every blocked stage with its reason. A run that reports `partial`
succeeded at what it could do and told the truth about the rest.

To reproduce the released retriever exactly:

```bash
cd services/fabric
python - <<'PY'
from fabric.pipeline import Pipeline, PipelineConfig
p = Pipeline(PipelineConfig(epochs=25)); rec = p.run()
card = p.registry.current()
print(rec.status, card.identifier, card.metrics)
PY
```

Deterministic apart from `latencyMs`. Seeds: data `1`, model `7`. See the
[model card](./model-cards/aetheris-lite-retriever-0.1.0.md).

---

## 7. Making chat actually work

Out of the box there is no language model, so `/api/chat` returns
`no_model_available` with the router's explanation. That is honest, and it is the
one step between this repository and a usable assistant.

**With Ollama** (the default provider, already enabled):

```bash
# install Ollama, then:
ollama pull qwen2.5:1.5b          # or any chat model your hardware can hold
curl -s http://127.0.0.1:11434/api/tags | head -c 200
```

Then either restart the core service or re-probe from the interface
(**Re-probe models**, top right). `/api/ready` should report
`capabilities.chat: true`, and the sidebar card should show `1/1 ready`.

**With llama.cpp:**

```bash
LLAMACPP_ENABLED=true \
LLAMACPP_BASE_URL=http://127.0.0.1:8080/v1 \
node services/core/src/server.mjs
```

Both runtimes are on loopback, so they stay reachable under `strict_offline` —
offline does not mean "nothing works".

**To verify offline enforcement is real** rather than cosmetic:

```bash
cd services/core && node --test test/offline.test.mjs
```

This starts a real HTTP server speaking the Ollama protocol, completes a genuine
chat round-trip under `strict_offline`, and proves with a recording `fetch` spy
that `api.openai.com`, `freellmapi.co`, `huggingface.co` and `api.anthropic.com`
are rejected without opening a socket or resolving DNS.

---

## 8. Enabling the online gateway

Optional, and off unless both a key and a base URL are present.

```bash
printf '%s' 'your-key' > /run/secrets/freellmapi_key && chmod 600 /run/secrets/freellmapi_key

AETHERIS_RUNTIME_POLICY=hybrid \
FREELLMAPI_BASE_URL=https://your-gateway.example.com \
FREELLMAPI_API_KEY_FILE=/run/secrets/freellmapi_key \
node services/core/src/server.mjs
```

The gateway is a **separately versioned service**; its code is not vendored here.
Deploy it from [its own repository](https://github.com/tashfeenahmed/freellmapi)
and read its "*Personal experimentation only*" note before pointing production
traffic at it.

Three things to know before enabling it:

1. **`hybrid`, not `online_enabled`,** unless you have a reason. `hybrid` keeps the
   data-classification ceiling: `confidential` and `restricted` content still
   needs explicit authorization per request. A fully online gateway needs
   `AETHERIS_ONLINE_ALLOWLIST=*` as well — an automatic host list is not implied by
   the policy, see [`05-security.md`](./05-security.md).
2. **The gateway's host is added to the allowlist automatically** from
   `FREELLMAPI_BASE_URL`. Allowlist matching is exact-host — no wildcards, no
   suffix matching.
3. **Video support is narrower than image support.** The gateway serves video on
   two platforms against eight for images, and marks video unsupported on custom
   endpoints. Chat working does not imply video works. See
   [`03-status.md`](./03-status.md) §3 and [`01-audit.md`](./01-audit.md) §3.

Prefer `*_FILE` over the inline variable so the secret never appears in the
process environment. A `VITE_*` variable whose name looks like a secret is
reported as a warning at config load, because Vite ships `VITE_*` into the browser
bundle.

---

## 9. Data locations

| Path | Contents | In git? |
|---|---|---|
| `$AETHERIS_DATA_DIR/knowledge.sqlite` | Document metadata, chunks, ACL grants, deletion records | no |
| `$AETHERIS_DATA_DIR/audit.sqlite` | Append-only audit ledger | no |
| `$AETHERIS_DATA_DIR/media/` | Generated images and video, addressed by sha256 | no |
| `$AETHERIS_FABRIC_DATA_DIR/` | Run records, weights (only if configured) | no |
| `apps/web/dist/` | Production bundle | no |

`.gitignore` excludes runtime data (`*.sqlite`, `.aetheris-data/`), secrets
(`.env`, `*.pem`, `*.key`), dependencies, build output, model artifacts
(`*.gguf`, `*.safetensors`, `checkpoints/`), generated media and logs. The BM25
index is **not** stored: it is rebuilt in memory from stored chunks at startup, so
it can never disagree with the database.

Deleting `$AETHERIS_DATA_DIR` removes all indexed company data. Document deletion
through the API (`purgeDocument`) is preferable: it keeps an auditable deletion
record rather than leaving an unexplained gap.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no_model_available` on every chat | No LM installed or not probed | §7, then re-probe |
| Web UI shows "Core service unreachable" | Core not running, or the proxy target is wrong | Start the core; check `AETHERIS_CORE_URL` |
| UI works locally but not behind a proxy | Dev server rejecting the host | Already handled: `allowedHosts: true`. Check the proxy forwards `/api` |
| `No module named pytest` | System interpreter has no pytest | `AETHERIS_PYTHON=/path/to/venv/bin/python` |
| `Database opened` / sqlite errors | Node < 22.5 | Upgrade Node; `node:sqlite` is required |
| Image/video refuse with `capability_unavailable` | No provider under the current policy | Expected. §8 to enable the gateway, or accept the refusal |
| Video refuses with `needs_hardware` | No local video runtime | Expected on this hardware class. The refusal never substitutes a still image |
| Fabric `POST /pipeline/run` returns `failed` | Trained MRR below the 0.60 release floor | Correct behaviour. Raise `epochs`; see the model card's release requirements |
| Fabric returns 413 | Body over 1 MB | Expected; this service takes small JSON commands, not datasets |
| A blank `AETHERIS_RUNTIME_POLICY` | — | Fails safe to `strict_offline` and records a warning. It never fails open |

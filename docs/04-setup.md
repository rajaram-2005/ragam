# 04 — Setup

> **Active product: online-only (Phase 2).** [Current setup, features and limitations](19-online-only-phase-2.md) supersede the offline-first product instructions below. Legacy local/research code remains for reference and regression tests; it is not loaded by `npm run core`. Suite totals include retained legacy coverage.

Every command below was run on the host described in
[`03-status.md`](./03-status.md). Nothing here is aspirational.

---

## 1. Requirements

| Component | Needs | Verified with |
|---|---|---|
| `services/core` | **Node ≥ 22.5.0** (for `node:sqlite`). Zero npm dependencies | Node v22.22.3 |
| `services/fabric` | **Python ≥ 3.11** + **NumPy** | Python 3.11.2, NumPy 2.1.3 |
| `apps/web` | Node 22.x and npm. Vite 8 requires ≥ 20.19 or ≥ 22.12; the Vercel function runtime is pinned to Node 22. 2 runtime packages, 23 installed in total | Vite 8.3.4, React 18.3.1 |
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
never needs to know where the backend lives. Then **create the first account** at
`#/signup` — it becomes the owner, and only the owner can connect a gateway (§7).

Expected startup banner from the core, on a fresh installation:

```
Aetheris online-only API listening on 0.0.0.0:8790
  data dir   /home/you/aetheris-omni/.aetheris-data/online
  sign-in    no accounts yet — open the web app and create the first one; it becomes the owner
Configure an online gateway (LiteLLM, Ollama or llama.cpp server) in Provider Settings. No local inference or automatic model downloads.
```

Once an account exists, the third line reports the account count and whether an owner is configured, without logging an email address. A `cookie` line appears whenever the session cookie's SameSite policy is not the default. A `(node:NNNN) ExperimentalWarning: SQLite is an experimental feature` line
above the banner comes from `node:sqlite` and is expected on Node 22.

That banner, with no model listed anywhere in it, **is the correct output** on a
fresh installation: this entry point performs no inference and installs nothing,
so there is nothing local to report. It is not an error, and the interface does
not soften it — Chat shows the same fact as a banner until a gateway is saved.

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
| `AETHERIS_CORE_PORT` | `8790` | Explicit bind-port override; when unset, the active entry uses the host-provided `PORT` before falling back to `8790` |
| `PORT` | *(managed host supplied)* | The hosting platform supplies the listening port; ignored when `AETHERIS_CORE_PORT` is explicitly set |
| `AETHERIS_ONLINE_DATA_DIR` | `./.aetheris-data/online` | Active online account/provider/SQLite data directory; place on persistent storage in production |
| `AETHERIS_TRUSTED_WEB_ORIGINS` | *(empty)* | Exact HTTPS browser origins accepted through the Vercel same-origin API proxy; comma-separated, no wildcard |
| `AETHERIS_COOKIE_SECURE` | `true` | Keep Secure on for production HTTPS cookies |
| `AETHERIS_COOKIE_SAMESITE` | `strict` | Safe with the Vercel same-origin proxy; `none` is only for genuinely cross-site embedding and requires Secure |
| `AETHERIS_ONLINE_TIMEOUT_MS` | `120000` | Upstream gateway time budget; when using the 60-second Vercel proxy, configure Core below the proxy's function limit |
| `AETHERIS_MODEL_CATALOG_FILE` | unset | Optional operator-owned versioned catalog-source JSON; metadata only, no automatic remote refresh. See [17](./17-model-catalog.md) |
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
npm test             # 101 web tests
```

| Variable | Default | Purpose |
|---|---|---|
| `WEB_PORT` | `5173` | Dev/preview server port |
| `AETHERIS_CORE_URL` | `http://127.0.0.1:8790` | Dev-server proxy target only. Node-side; never reaches the browser |
| `NODE_ENV` | `development` locally; `production` on Vercel | The Vercel proxy permits loopback HTTP only in development; production requires HTTPS |
| `CORE_API_URL` | *(Vercel project variable)* | `/api` function's fixed HTTPS Core origin; never exposed to the browser |

The dev server binds `0.0.0.0` with `allowedHosts: true` so it works behind a
container port-forward or a preview proxy. Browser-facing code uses relative
`/api` paths exclusively; `apps/web/test/api.test.mjs` fails if any absolute host
appears in `src/`.

**Production:** `npm run build`, then serve `dist/` from anything that can also
proxy `/api` to the core service (nginx, Caddy, or the core itself behind a
reverse proxy). No absolute backend URL is baked into the bundle, so the same
build works against any origin that proxies `/api`.

### Hosted deployment status

The frontend can be hosted separately from Core, but this repository does not currently configure a managed Core host. The earlier paid hosting configuration was removed to meet the zero-cost requirement. This does not remove or cancel anything in an external hosting account. See [deployment status and requirements](./deployment-status.md) before connecting a hosted Core API. A free compute tier is not sufficient if its filesystem is ephemeral: Core stores account and provider state on disk, so do not use temporary storage for real data.

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
npm run lm:train   # the release configuration, ~35-40 minutes on 2 CPU cores
```

### Export a model the core can load

```
python services/fabric/scripts/export_lm.py --from-run services/fabric/artifacts \
    --id aetheris-lite-lm --version 0.1.0
python services/fabric/scripts/export_lm.py --verify <output-dir>
# the cross-language parity fixture services/core tests against
python services/fabric/scripts/export_lm.py --parity-fixture \
    services/core/test/fixtures/klyvaron-lite-parity.json
```

Install it with the operator's command, which drives the store — the only thing that may
write under `<AETHERIS_DATA_DIR>/klyvaron/models`:

```bash
node services/core/scripts/klyvaron.mjs install <artifact-dir>   # verify, budget, copy, re-verify, record
node services/core/scripts/klyvaron.mjs list
node services/core/scripts/klyvaron.mjs verify [<artifact-id>]
node services/core/scripts/klyvaron.mjs status                    # what the app reports, no server needed
node services/core/scripts/klyvaron.mjs remove <artifact-id> --yes
```

`install` takes four gates in order — verify the artifact, ask the storage budget, copy,
re-verify what landed and record its digest — and refuses rather than warns: results are
JSON on stdout, a refusal is JSON on stderr with exit code 1, `list` and `verify` exit 1
when an artifact is broken, and `remove` without `--yes` prints the artifact it would
delete and exits 2. Copying an artifact into `<AETHERIS_DATA_DIR>/klyvaron/models/<id>/` by hand
also works, and the core still verifies the digests at startup and reports the model over
`/api/models`, `/api/ready` and `/api/storage`; what a hand copy skips is the budget check
and the install record, so the device's own accounting will not have seen the artifact
arrive. A model that fails verification is reported as broken and left on disk, never
deleted.

The training runs and the export both write to `services/fabric/artifacts/`, which is
**gitignored by policy**:
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

### Optional real LoRA smoke run

The normal Fabric service is NumPy-only. On a separate machine with Python 3.11+,
internet access, about 8 GB RAM and sufficient disk, the real Hugging Face + PEFT
smoke path bootstraps its optional packages and runs on CPU or CUDA:

```bash
python services/fabric/remote/run_smoke_local.py --workdir ./aetheris-smoke
# inspect aetheris-smoke/status.json
```

The work directory contains model and optimizer bytes and is gitignored. On an
externally managed system Python, the bootstrap retries with
`--break-system-packages` only after pip explicitly returns its PEP 668 refusal; it
still installs to the user site. This path has not completed a real model run yet;
see [the remote-training record](./21-remote-training.md) for the stage meanings and
limitations.

---

## 4. Tests

```bash
npm test                  # all three suites (1896 tests)
npm run test:core         # 973
npm run test:web          # 101
npm run test:fabric       # 822 — needs numpy + pytest on the interpreter
```

Beyond the suites, one check is run by hand rather than by CI, because it costs nine suite
runs and only needs re-running when a rule it covers changes:

```bash
cd services/fabric
python scripts/mutation_check.py   # ~4 min: removes each rule in docs/21 §11 one at a time
                                   # and requires the suite to fail; exits 1 on an escape
                                   # or on a rule whose anchor text has moved
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
pull request against `main`. Five jobs, split so a failure names the component that
broke instead of surfacing as one red check:

Five jobs run on every push to `main` or `arena/**`, on every pull request against
`main`, and **weekly on Mondays at 04:17 UTC**. The scheduled run exists because the
advisory gates below check against databases that change continuously: a commit that
was clean when it merged can become vulnerable later, and a trigger that only fires
when something else changes would not notice.

| Job | What it proves |
|---|---|
| **Core service** | 973 tests pass in CI; verifies `services/core` still declares **zero** dependencies and confirms no `services/core/node_modules` exists. Latest successful full run: [41056477712](https://github.com/rajaram-2005/ragam/actions/runs/41056477712) at commit `bc7022b`. |
| **Fabric** | 822 tests pass; `torch` is **not** importable; the release gate is exercised end to end in both directions; and `scripts/audit_python_deps.py` checks numpy and the test tooling against the GitHub Advisory Database, failing on a covered version **and** on being unable to reach the database |
| **Web app** | `npm ci`, 101 tests, **two `npm audit` gates** (production clean at every severity; full tree failing on high/critical), production build, then a scan of the built artifact for an absolute loopback backend URL and for credential-shaped strings |
| **Docs** | The 49-test documentation-accuracy suite, checked out with full history because it asserts the model card records a real git SHA and was re-verified at a *different* revision; plus a check that the four licence copies are present and untruncated |
| **Release** | Runs all three suites with TAP output, counts what they reported, and passes those counts to `services/core/scripts/release-check.mjs`; then runs the benchmark harness and fails if any benchmark failed. This is the job that makes "the documents state the measured totals" a checked claim rather than a convention |

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

The active product — `npm run core`, which is `services/core/src/server.mjs` — performs
**no local inference and downloads no models**. It sends chat to **one** configured online
endpoint at a time, of one of three kinds: a **LiteLLM** gateway, an **Ollama** server, or a
**llama.cpp** server (`llama-server`). All three are called the same way:
`GET {base}/models` and `POST {base}/chat/completions`. A LiteLLM gateway always needs a
Bearer key. Ollama and llama.cpp need one only if you set it (`llama-server --api-key`).
Until a connection is saved, `/api/ready` reports `status: "setup_required"`
with `capabilities.chat: false`, the model list is empty, and Chat says so in a banner
rather than failing quietly. That empty state is not a defect and no amount of
re-signing-in changes it: it is the product waiting for a gateway or runtime.

Sign in as the **owner** account (the first one created on an installation), open
**Provider Settings**, and enter:

| Field | Value |
|---|---|
| Runtime | `LiteLLM gateway`, `Ollama` or `llama.cpp server`. Choosing one starts from an empty endpoint |
| API base URL | your gateway's `/v1` base, e.g. `https://gateway.example/v1`; for Ollama `http://<core-host>:11434/v1`; for llama.cpp `http://<core-host>:8080/v1`. The `/v1` matters: Core appends `/models` and `/chat/completions` to whatever you enter |
| API key | required for LiteLLM; optional for Ollama and llama.cpp. A saved key is never carried over to a different runtime or endpoint |

A **local** Ollama or llama.cpp server is still **online** inference from the product's point
of view: the request leaves Core for that endpoint, and the UI and the audit ledger say so.
Because it is a loopback or private address, Core refuses it unless its exact origin is
listed in `AETHERIS_TRUSTED_ORIGINS` on the Core host, for example
`AETHERIS_TRUSTED_ORIGINS=http://127.0.0.1:11434`. Run Core with that variable set, then save.

**Save connection**, then **Test connection & refresh models**. The list fills with the
ids the gateway reports; pick one in Chat. The model you pick is the model that is
called — there is no substitution and no fallback, so a model that is listed but broken
fails visibly instead of quietly answering from somewhere else.

### Local models behind a local gateway

The gateway may itself be on your own machine and front a local runtime. That is how this
product runs on local models without being changed: Core still does no inference, it just
talks to a gateway that happens to be on loopback.

```bash
ollama serve                                    # 127.0.0.1:11434
ollama pull qwen2.5:1.5b                        # or any chat model your hardware can hold
pip install 'litellm[proxy]'
litellm --model ollama/qwen2.5:1.5b --port 4000 --master_key sk-local-dev

AETHERIS_LITELLM_TRUSTED_ORIGINS=http://127.0.0.1:4000 npm run core
npm run web
```

Then in Provider Settings: base URL `http://127.0.0.1:4000/v1`, key `sk-local-dev`. The
model id you will see is whatever the proxy reports — `ollama/qwen2.5:1.5b` with the
command above, or `qwen2.5:1.5b` if you configure the proxy with a `model_list` YAML
instead. Check the two endpoints Core actually calls before blaming the app:

```bash
curl -H 'authorization: Bearer sk-local-dev' http://127.0.0.1:4000/v1/models
curl -H 'authorization: Bearer sk-local-dev' -H 'content-type: application/json' \
  -d '{"model":"ollama/qwen2.5:1.5b","messages":[{"role":"user","content":"Say hi"}],"stream":true}' \
  http://127.0.0.1:4000/v1/chat/completions
```

`AETHERIS_LITELLM_TRUSTED_ORIGINS` exists because a private or loopback gateway is
refused by default — otherwise anybody who can reach the API could point an installation
at an internal address. It is compared against the URL's **exact origin**: scheme, host
and port, with no path and no trailing slash. `http://127.0.0.1:4000/` does not match,
and neither does `http://localhost:4000` when the base URL says `127.0.0.1`. It is read
once at boot, so changing it means restarting Core. Comma-separated for more than one.

### What the refusals mean

| Response | Cause |
|---|---|
| `400 endpoint_blocked` | A private or loopback base URL whose origin is not in `AETHERIS_LITELLM_TRUSTED_ORIGINS`, or does not match it exactly |
| `400 invalid_endpoint` | Not a parseable HTTP(S) URL, or it carries credentials, a query or a fragment |
| `400 key_required` | No key was sent, and a saved key is never reused for a different endpoint |
| `400 invalid_key` | A key over 8192 characters, or one containing a line break |
| `403 owner_required` | A member account tried to change the gateway; only the owner can |
| `502 invalid_model_list` | The gateway's `/models` answer was not a list of at most 500 records |
| `502 invalid_stream` | A streaming request did not get `text/event-stream` back — usually a base URL missing `/v1`, or the gateway answering with an error page |
| `409 provider_changed` | The connection was re-saved while a check or a request was in flight |
| `409 model_unavailable` | The model asked for is not in the listed set |

### The retained legacy service has its own local adapters

`services/core/src/providers/local.mjs` holds working Ollama (`/api/tags`, streaming
`/api/chat`) and OpenAI-compatible llama.cpp (`/v1/models`, `/v1/chat/completions`)
adapters, and `services/core/src/config.mjs` reads `OLLAMA_*` and `LLAMACPP_*`. Both
belong to the **legacy** entry point, `src/legacy-server.mjs` — not what `npm run core`
runs, and a service with no accounts and no `/api/auth`, so the web app in `apps/web`
cannot sign into it. Setting `LLAMACPP_ENABLED=true` in front of `npm run core` does
nothing at all: the online entry never reads that variable. The online entry reaches the
same runtimes through their OpenAI-compatible `/v1` routes instead, with the transport
controls described in §7 — set the runtime in Provider Settings, not in `.env`.

---

## 8. External providers and metadata catalogs

**The active build routes Chat, Image and Video through one guarded online transport.** Its provider
registry has 39 entries: 23 `ready` entries with tested code paths, fourteen audited Chat providers
with individually defined contract-tested adapters (retaining `gateway_only` for catalogue
compatibility), and two `pending` local media stacks with no adapter. Contract tests do not qualify
live vendor access. No vendor is contacted unless you save its endpoint and credential in Provider
Settings, and every request goes only to the connection that names it. See
[docs/27](27-provider-framework.md); FreeLLMAPI remains excluded.

**Image and video generation are real, for one provider each.** Save an OpenAI Images connection
and a Google Veo connection, test each to list its models, then generate from the Image or Video
area. Both are asynchronous durable jobs; the bytes are validated by the Core, stored under the
account's data directory, and served only by the job that produced them. Video polls a
long-running operation, can be cancelled, and never substitutes a still image or a simulated clip.

Optional **metadata-only** sources are now configured using
`AETHERIS_MODEL_CATALOG_FILE`; see [17 — Model catalog](./17-model-catalog.md).
Credentials stay in protected server-side files. An explicit refresh is separate
from inference authorization, and Strict Offline blocks external catalog sources,
even a loopback model gateway that could consult upstream services.

Image and Video still report no generation provider: both answer
`capability_unavailable` rather than substituting output, and the refusal is
audited. Text inference through the LiteLLM gateway does ship, with the data
policy, identity, streaming and cancellation that the online entry enforces
([docs/19](19-online-only-phase-2.md)); what has not shipped is *more than one*
provider, per-account provider connections, and any generation modality.

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

### User-computer-first local worker (`npm run worker`)

RAGAM never assumes a server or coding host is the user's computer, never triggers weight training from ordinary chat messages, and never auto-ingests private conversations. To execute authorized local adaptation or foundation runs on your own machine:

```bash
# Start the authenticated local worker on loopback (Linux, macOS, Windows):
npm run worker -- --workspace ./.aetheris-data/worker-workspace --pairing-secret "<single-use-secret>"
```

1. In Chat → **User-computer local worker & explicit learning**, click **Generate pairing code** to mint a short-lived single-use `pairingSecret`.
2. Start `npm run worker` on your machine and complete mutual Bearer token pairing (`POST /api/klyvaron/worker/pair/complete`).
3. Inspect hardware & plan (`POST /api/klyvaron/worker/evaluate`): single corrections prefer `memory_or_retrieval`; multi-example interactive LoRA adapters enforce a hard **120-second wall-clock ceiling including finalization** (`120,000 ms`); full fine-tuning / foundation pretraining are never silently downgraded to adapters without explicit user approval.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Empty model list, Chat disabled, `/api/ready` says `setup_required` | No gateway saved yet | §7 — Provider Settings, then **Test connection & refresh models** |
| `400 endpoint_blocked` when saving a gateway | A loopback or private base URL whose origin is not trusted | §7 — set `AETHERIS_LITELLM_TRUSTED_ORIGINS` to the exact origin and restart Core |
| Sign-in succeeds, then the app returns to the sign-in page | The session cookie is not being sent — the app is inside another site's iframe and the cookie is `SameSite=Strict` | Start Core with `AETHERIS_COOKIE_SAMESITE=none` and `AETHERIS_COOKIE_SECURE=true`; see [docs/20](20-accounts-and-sign-in.md) |
| `502 invalid_stream` on every message | The base URL is missing `/v1`, or the gateway answers with an error page | §7 — check the two `curl` calls against the gateway directly |
| Web UI shows "Core service unreachable" | Core not running, or the proxy target is wrong | Start the core; check `AETHERIS_CORE_URL` |
| UI works locally but not behind a proxy | Dev server rejecting the host | Already handled: `allowedHosts: true`. Check the proxy forwards `/api` |
| `No module named pytest` | System interpreter has no pytest | `AETHERIS_PYTHON=/path/to/venv/bin/python` |
| `Database opened` / sqlite errors | Node < 22.5 | Upgrade Node; `node:sqlite` is required |
| Image says `provider_not_configured` | No OpenAI Images connection is saved | §8 — add an OpenAI Images connection and test it. Video has no adapter and still answers `capability_unavailable` |
| Video refuses with `needs_hardware` | No local video runtime | Expected on this hardware class. The refusal never substitutes a still image |
| Fabric `POST /pipeline/run` returns `failed` | Trained MRR below the 0.60 release floor | Correct behaviour. Raise `epochs`; see the model card's release requirements |
| Fabric returns 413 | Body over 1 MB | Expected; this service takes small JSON commands, not datasets |
| A blank `AETHERIS_RUNTIME_POLICY` | — | Fails safe to `strict_offline` and records a warning. It never fails open |

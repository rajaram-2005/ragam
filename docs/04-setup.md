# 04 — Setup

> **Active product: online-only (Phase 2), with two deployment modes.** The default Docker Compose workspace is local, single-user and loopback-only, with an optional shared-password Caddy mode for trusted LANs. The opt-in hosted BYOK edition uses Supabase Auth/Postgres and Vercel Node functions; see [Hosted BYOK setup and security](30-hosted-byok.md). The web client build flag is off unless explicitly enabled. Legacy local/research code remains for reference and regression tests; suite totals include retained coverage.

Every command below was run on the host described in
[`03-status.md`](./03-status.md). Nothing here is aspirational.

---

## 1. Requirements

| Component | Needs | Verified with |
|---|---|---|
| `services/core` | **Node ≥ 22.5.0** (for `node:sqlite`). Zero npm dependencies | Node v22.22.3 |
| `services/fabric` | **Python ≥ 3.11** + **NumPy** | Python 3.11.2, NumPy 2.1.3 |
| `apps/web` | Node 22.x and npm. Vite 8 requires ≥ 20.19 or ≥ 22.12. 2 runtime packages, 23 installed in total | Vite 8.3.4, React 18.3.1 |
| Tests | Core processor/routes and Web tests require no model files; retained Fabric/worker tests may use Python dependencies and `pytest` | Python 3.11.2, NumPy 2.4.6, JAX 0.10.2, PyAV 18.1.0, Pillow 13.0.0, pytest 9.1.1 |

No GPU or model weights are required to run Klyvaron's built-in processor or its Core/Web tests — see §7. Retained model-artifact and worker tests cover separate legacy paths; optional Python test prerequisites are described in §4 and kept outside Git. Passing those tests is not evidence that a model release has occurred.

> **Do not `pip install torch`.** Nothing here imports it. On a GPU-less host pip
> resolves torch to the CUDA build and pulls several gigabytes of runtime that
> cannot be used. This happened during the audit and had to be unwound.
> `services/fabric` is deliberately NumPy-only.

---

## 2. Quick start

**The default end-user deployment is Docker Compose.** Use the [self-hosted Docker guide](22-self-hosted-deployment.md), including the Windows double-click launcher, to run an independent local instance with persistent storage. A separate, opt-in hosted BYOK edition is available for Vercel/Supabase; it has a distinct auth/data path and requires production SMTP before public registration. See [docs/30](30-hosted-byok.md). The Node/Vite steps below are for repository development and tests.

```bash
git clone https://github.com/rajaram-2005/ragam.git aetheris-omni
cd aetheris-omni

cp .env.example .env                    # reference for values; Node does not load .env automatically

# 1. the core service (Node, no install step); local mode has no account/email flow
AETHERIS_LOCAL_SINGLE_USER=true node services/core/src/server.mjs

# 2. the web app (separate terminal)
cd apps/web && npm install && npm run dev
```

Open the URL Vite prints. It proxies `/api` to Core, so the browser never needs to
know where the backend lives. Local single-user mode is intended only for a trusted
loopback connection. For Docker deployment, persistent volumes and backup/restore,
see [the self-hosted deployment guide](22-self-hosted-deployment.md).

Expected startup banner from the core, on a fresh installation:

```
Aetheris online-only API listening on 127.0.0.1:8790
  data dir   /home/you/aetheris-omni/.aetheris-data/online
  access     single-user workspace, localhost only; no account or email login
Configure a supported provider in Provider Settings. Model ids are fetched from its configured account; no local inference, guessed model list or automatic fallback.
```

A `(node:NNNN) ExperimentalWarning: SQLite is an experimental feature` line above
the banner comes from `node:sqlite` and is expected on Node 22.

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
| `AETHERIS_CORE_HOST` | `0.0.0.0` with account mode; `127.0.0.1` in local single-user mode | Bind address. Compose keeps Core private and exposes only localhost through Caddy |
| `AETHERIS_CORE_PORT` | `8790` | Explicit bind-port override; when unset, the active entry uses the host-provided `PORT` before falling back to `8790` |
| `PORT` | *(optional)* | Generic Node hosting port; ignored when `AETHERIS_CORE_PORT` is explicitly set. Docker Compose sets the Core port explicitly. |
| `AETHERIS_ONLINE_DATA_DIR` | `./.aetheris-data/online` | Active online workspace/provider/SQLite data directory; place on persistent storage |
| `AETHERIS_LOCAL_SINGLE_USER` | `false` for direct Core; fixed `true` in Compose | Opens directly without accounts; restricts browser Host headers to localhost and disables account endpoints |
| `AETHERIS_TRUSTED_WEB_ORIGINS` | *(empty)* | Optional exact HTTPS origins for a frontend served on a separate origin; comma-separated, no paths or wildcards. The Docker Compose app is same-origin and needs no entry. |
| `AETHERIS_COOKIE_SECURE` | `true` | Keep Secure on for production HTTPS cookies |
| `AETHERIS_COOKIE_SAMESITE` | `strict` | Same-origin default; `none` is only for genuinely cross-site embedding and requires Secure |
| `AETHERIS_ONLINE_TIMEOUT_MS` | `120000` | Upstream gateway time budget |
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
npm ci               # install exact versions from package-lock.json
npm run dev          # dev server with HMR
npm run build        # production bundle into dist/
npm run preview      # serve the built bundle
npm test             # 131 web tests
```

| Variable | Default | Purpose |
|---|---|---|
| `WEB_PORT` | `5173` | Dev/preview server port |
| `AETHERIS_CORE_URL` | `http://127.0.0.1:8790` | Dev-server proxy target only. Node-side; never reaches the browser |

The dev server binds `0.0.0.0` with `allowedHosts: true` so it works behind a
container port-forward or a preview proxy. Browser-facing code uses relative
`/api` paths exclusively; `apps/web/test/api.test.mjs` fails if any absolute host
appears in `src/`.

**Local-workspace production:** `npm run build`, then serve `dist/` from anything that can also
proxy `/api` to the core service (nginx, Caddy, or the core itself behind a
reverse proxy). No absolute backend URL is baked into the bundle. The separate hosted BYOK
build uses `VITE_HOSTED_BYOK=true` and the fixed `/api/hosted/*` rewrite; see
[docs/30](30-hosted-byok.md) for Vercel/Supabase configuration and the SMTP launch gate.

### Native desktop preview (Windows, macOS, Linux)

The Electron shell runs the same React build and the same Node Core service. Both its
HTTP listeners bind only to `127.0.0.1`; the desktop Core uses local single-user mode,
and its persistent workspace is stored in Electron's per-user `Ragam` data directory.
It does not open a LAN listener. The local CPU model runtime is JavaScript, so inference
uses the same verified artifact format on x64 and ARM64; accelerator-specific execution
is not implied by this desktop package.

From a source checkout with Node.js 22.12 or later:

```bash
npm run desktop:install
npm run desktop          # build the web bundle, then launch the local desktop app
npm run desktop:build    # build an installer for the build host's current OS
```

[The Desktop Packages workflow](../.github/workflows/desktop.yml) builds Windows NSIS,
Linux AppImage/deb, and macOS DMG artifacts for x64 and ARM64. These are **unsigned CI
artifacts**, retained for 14 days; they are not published releases. Windows SmartScreen
and macOS Gatekeeper may warn because no signing identity is configured. A signed,
public installer requires platform-specific signing and release work.

Model weights are not bundled or fetched by the desktop app. Lite/Pro/Max entries in
Provider Settings are explicit provider/model assignments, not first-party weights.
Separately installed first-party model artifacts belong to a retained legacy integration;
they are not the Klyvaron built-in processor, are not required for Chat, and do not establish
that a Klyvaron model has been released. If that optional path is enabled, the UI gates it on
digest verification and inference readiness rather than substituting missing files. These
artifacts do not imply that the full multimodal tiers are complete; see the [family readiness
matrix](11-klyvaron-family.md).

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

## 3b. Archived language-model experiment (not Klyvaron)

This is retained historical tooling, not the model-independent Klyvaron architecture. It is
not used by Chat's built-in processor, and running it is neither necessary nor evidence of a
Klyvaron capability or model release. No training or weight installation is part of the normal
product setup. The old experiment commands are kept below for repository-history and test
context only.

The legacy experiment used random initialisation and no downloads:

```bash
npm run lm:quick   # legacy experiment, 60 steps — proves its pipeline end to end
npm run lm:train   # legacy experiment; not a Klyvaron release or setup command
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

The retained legacy operator command can install a separately verified artifact for that
optional old inference path. It is not needed by the built-in Klyvaron processor and does not
mark a model release. The command drives the store — the only thing that may write under
`<AETHERIS_DATA_DIR>/klyvaron/models`:

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

### Full Core test prerequisites

The application itself needs neither Python nor model weights. To run the **entire** Core acceptance suite locally, provide the Python test environment and the same genuine, digest-verified first-party artifacts used by CI. The artifacts live only under ignored `.aetheris-data/`; they are not committed. Run from the repository root:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install numpy==2.4.6 jax==0.10.2 av==18.1.0 Pillow==13.0.0 pytest==9.2.0
mkdir -p .aetheris-data/online/klyvaron/models
curl -fsSL https://codeload.github.com/rajaram-2005/ragam/tar.gz/c9f6aa2f5e31ed462caae1f94395ba46ea808a40 \
  | tar -xz --strip-components=1 -C .aetheris-data/online/klyvaron/models
(
  cd .aetheris-data/online/klyvaron/models
  cat klyvaron-max-lm/klyvaron-max-lm-0.1.0.npz.part* > klyvaron-max-lm/klyvaron-max-lm-0.1.0.npz
  sha256sum -c SHA256SUMS
)
PATH="$PWD/.venv/bin:$PATH" node --test services/core/test/*.test.mjs services/core/test/klyvaron-release/*.test.mjs
```

The pinned archive includes the model manifests and checksum list. The full CI run [41394564087](https://github.com/rajaram-2005/ragam/actions/runs/41394564087) passed all 985 Core tests with the pinned Pro/Max artifacts and Python prerequisites. The Baidu Qianfan contract fixtures make no vendor calls. Without the packages and Python libraries, the artifact/worker acceptance tests fail closed rather than substituting fixtures or downgrading model claims. The Core service still declares zero npm dependencies.

```bash
PATH="$PWD/.venv/bin:$PATH" npm test  # all three suites (2052 tests)
npm run test:core                  # 1086
npm run test:web                   # 143
npm run test:fabric                # 823 — needs numpy + pytest on the interpreter
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

The same `AETHERIS_PYTHON` value is honored by Core's retained Python worker
paths, so a configured interpreter is used consistently rather than probing a
different `python3` environment. It is documented as a commented optional value
in [`.env.example`](../.env.example).

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
pull request against `main`. Six jobs, split so a failure names the component that
broke instead of surfacing as one red check:

Six jobs run on every push to `main` or `arena/**`, on every pull request against
`main`, and **weekly on Mondays at 04:17 UTC**. The scheduled run exists because the
advisory gates below check against databases that change continuously: a commit that
was clean when it merged can become vulnerable later, and a trigger that only fires
when something else changes would not notice.

| Job | What it proves |
|---|---|
| **Core service** | Current suite: 1086 tests; verifies `services/core` still declares **zero** dependencies and confirms no `services/core/node_modules` exists. Run [41394564087](https://github.com/rajaram-2005/ragam/actions/runs/41394564087) is a historical CI result and does not establish a Klyvaron model release; Baidu Qianfan is covered by local contract fixtures. |
| **Fabric** | 823 tests pass; `torch` is **not** importable; the release gate is exercised end to end in both directions; and `scripts/audit_python_deps.py` checks numpy and the test tooling against the GitHub Advisory Database, failing on a covered version **and** on being unable to reach the database |
| **Web app** | `npm ci`, 143 tests, **two `npm audit` gates** (production clean at every severity; full tree failing on high/critical), production build, then a scan of the built artifact for an absolute loopback backend URL and for credential-shaped strings |
| **Docker Compose** | Run [41394564087](https://github.com/rajaram-2005/ragam/actions/runs/41394564087) passed: builds both images, starts Core/web/Caddy on loopback, checks local-workspace health and the provider catalogue with account creation disabled, then cold-backs up and restores the named volume and verifies workspace identity plus a SQLite history marker. Synthetic CI only: no live provider inference or persistent-deployment guarantee. |
| **Docs** | The 52-test documentation-accuracy suite, checked out with full history because it asserts the model card records a real git SHA and was re-verified at a *different* revision; plus a check that the four licence copies are present and untruncated |
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

## 6. Legacy Fabric training experiment (separate from Klyvaron)

This section documents the retained Fabric retriever experiment only. It is not the Klyvaron
processor, does not power Chat, and is not needed to run the product or create persistent
knowledge. User-approved knowledge and memory are stored as data; they are not model training.
No model release is implied by these commands.

```bash
npm run train            # legacy Fabric experiment; in-process, prints "partial run-<id>"
npm run fabric:run       # legacy HTTP experiment (start `npm run fabric` first)
```

`partial` is the expected status: 3 of 8 stages are blocked on this host. The run
record lists every blocked stage with its reason. A run that reports `partial`
succeeded at what it could do and told the truth about the rest.

To reproduce the retained legacy retriever experiment exactly:

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

## 7. Built-in Klyvaron processing and optional media/model providers

The active product — `npm run core`, which is `services/core/src/server.mjs` — includes
Klyvaron's built-in, model-independent deterministic text processor; it downloads and loads
no model weights. Model-backed Chat is an optional separate integration. The catalogue includes direct Chat APIs
(OpenAI, Anthropic Claude, Google Gemini, Google Vertex AI, Azure OpenAI, Amazon Bedrock,
Cohere and other listed providers), separate Image APIs, and separate Video APIs. The
full provider matrix and each connection's authentication/endpoint details are in
[docs/27](./27-provider-framework.md). ChatGPT and Claude are product names; their API
connections are OpenAI and Anthropic respectively. Google Gemini and Vertex AI are
separate connection choices with different credential formats.

In Chat, the default **Klyvaron built-in** engine works without a model or provider. Choose a deterministic task (such as extractive summary, input inspection, local retrieval or bounded arithmetic) and a resource profile. Its output is limited to those documented operations; it does not provide open-ended language reasoning. Text and browser-extracted document text are supported, not binary-media understanding. See [33 — Model-independent Klyvaron](./33-model-independent-klyvaron.md).

### Connect an optional Chat provider in the browser

1. Sign in to the local Ragam installation as its **owner** and open **Provider Settings**.
2. Under **Add a connection**, select the API vendor (for example, OpenAI, Anthropic Claude
   or Google Gemini). Enter that vendor's API base URL and credential in the fields shown.
   Vertex AI, Bedrock and Fireworks may ask for structured credentials or extra account
   metadata; follow the field labels and the provider's own documentation.
3. Select **Save and use**, then **Test connection & refresh models**. This tests the model
   catalogue only; it does not send a chat prompt or prove live inference compatibility.
4. In Chat, switch the engine to **Optional connected AI provider**, then explicitly choose a listed model. Ragam sends that request to the selected connection, keeps provider/model provenance, and does not silently switch providers. API calls may incur provider charges; the default Klyvaron processor does not use this connection.

Enter credentials only in Provider Settings, never in chat or source files. Credentials are
stored encrypted by the local Core and are not returned by its API. A consumer ChatGPT or
Claude subscription should not be assumed to include API access or API usage; check the
provider's current API terms and billing before sending prompts. No live provider is contacted
merely by viewing the catalogue.

The catalogue currently has 46 entries: 23 `ready` entries with fixture-tested code paths,
22 individually contract-tested Chat adapters that retain the historical `gateway_only`
classification, and Diffusers as the sole `pending` entry. “Fixture-tested” is not a claim
of live account access or model qualification. No vendor credentials or live quota were
available for qualification in this repository. Synthetic fixtures prove request/response
handling only.

### Image and Video are separate connections

Open **Image** or **Video**, choose **Provider Settings**, and add a provider that supports
that modality; a Chat credential or model is not reused for media generation. Image has nine
cloud adapters plus the local ComfyUI adapter. Video has five cloud adapters. Select a listed
model in the relevant area and submit a generation explicitly; those requests can incur
provider charges. Returned artifacts are validated before Ragam stores or displays them.

ComfyUI is **local image generation only** in this integration. It needs a running ComfyUI
HTTP service and an installed checkpoint; Ragam installs neither. After you save the endpoint and select **Test connection & refresh models**, Ragam also reads ComfyUI’s `/system_stats` report and shows the devices, backend labels, reported VRAM and installed checkpoint names. This is automatic hardware reporting from the connected ComfyUI process—not a hardware qualification or proof that a particular checkpoint fits. Ragam does not choose, download or silently substitute a model.

The exact endpoint origin must be trusted by Core. In Docker, `localhost` refers to the Core container, not Windows, and `http://comfyui:8188` works only if a ComfyUI service named `comfyui` is on the same private Docker network. The default Compose stack does not start that service. Do not expose unauthenticated ComfyUI to the LAN or Internet. Diffusers remains pending until a concrete service/model and license are selected.

Until a Chat connection is saved, `/api/ready` may report `status: "setup_required"` with
`capabilities.chat: false` for the optional model-backed route. The built-in Klyvaron processor
remains available for its deterministic text workflows. Saving connections does not qualify a
model: model-list success is not inference verification, and no fallback is performed.

### Local models with Ollama or llama.cpp

Ragam connects directly to a local Ollama or llama.cpp server; LiteLLM is not required or
supported. Start the local service and install a model yourself:

```bash
ollama serve
ollama pull qwen2.5:1.5b
npm run core
npm run web
```

In Provider Settings, choose **Ollama (on the Core host)** and use
`http://127.0.0.1:11434/v1`; the key is optional. For llama.cpp, start `llama-server`
and use its `/v1` base URL; a key is only needed if you started it with `--api-key`.
The **exact origin** must be trusted by Core, for example:

```bash
AETHERIS_TRUSTED_ORIGINS=http://127.0.0.1:11434 npm run core
```

If Core runs in Docker, `127.0.0.1` means the Core container, not the host. Use a local
runtime on the same private container network or a host address reachable from Core, and
trust that exact origin. Do not expose an unauthenticated model server publicly.

### What the refusals mean

| Response | Cause |
|---|---|
| `400 endpoint_blocked` | A private or loopback base URL whose origin is not in `AETHERIS_TRUSTED_ORIGINS`, or does not match it exactly |
| `400 invalid_endpoint` | Not a parseable HTTP(S) URL, or it carries credentials, a query or a fragment |
| `400 key_required` | No key was sent, and a saved key is never reused for a different endpoint |
| `400 invalid_key` | A key over 8192 characters, or one containing a line break |
| `403 owner_required` | A member account tried to change a provider connection; only the owner can |
| `502 invalid_model_list` | The provider's `/models` answer was not a list of at most 500 records |
| `502 invalid_stream` | A streaming request did not get `text/event-stream` back — usually a base URL missing `/v1`, or the endpoint answering with an error page |
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
registry has 46 entries: 23 `ready` entries with tested code paths, twenty-two individually adapted Chat providers
with individually defined contract-tested adapters (retaining `gateway_only` for catalogue
compatibility), and one `pending` local media entry (Diffusers). The optional ComfyUI image adapter
uses its local HTTP API and a built-in stock workflow; Ragam does not install ComfyUI or model
checkpoints. Contract tests do not qualify live vendor access. No vendor is contacted unless you
save its endpoint and credential in Provider Settings and explicitly test or send a request. See
[docs/27](27-provider-framework.md); FreeLLMAPI remains excluded.

**Image and video generation have separate provider adapters.** Ten image integrations (nine
cloud providers plus ComfyUI) and five video providers have fixture-tested request/result paths;
no vendor has been live-qualified here. Save the connection you choose, explicitly test it to list
models, then submit a job from the Image or Video area. Jobs are durable and returned media bytes are
validated by Core before storage and display. ComfyUI requires an already-running service reachable
from Core and an exact-origin entry in `AETHERIS_TRUSTED_ORIGINS`; it uses installed checkpoints and
does not download or choose weights. Keep an unauthenticated ComfyUI service off the LAN/Internet.
Provider requests may incur charges; no calls happen merely because a catalogue entry is visible.

Optional **metadata-only** sources are now configured using
`AETHERIS_MODEL_CATALOG_FILE`; see [17 — Model catalog](./17-model-catalog.md).
Credentials stay in protected server-side files. An explicit refresh is separate
from inference authorization, and Strict Offline blocks external catalog sources,
even a loopback model gateway that could consult upstream services.

A ComfyUI connection is not installed by the standard Compose stack. For an existing private ComfyUI
service, configure its base URL in Provider Settings and add that exact origin to
`AETHERIS_TRUSTED_ORIGINS` in the Core environment before restarting the stack. For example, use
`http://host.docker.internal:8188` only when the service is reachable from the Core container and
network/firewall policy keeps the unauthenticated endpoint private. Then select **ComfyUI (local)**,
click **Test connection & refresh models**, and choose an enumerated checkpoint in the Image area.
Saving only records the endpoint; Test performs local checkpoint discovery, and Generate submits the
explicit user prompt. Diffusers remains unselectable until a concrete service API is chosen.

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

### Legacy optional user-computer worker (`npm run worker`)

This retained worker is a separate research feature, not the model-independent Klyvaron processor or its user-authorized knowledge/memory stores. No worker, adaptation, training or foundation run is needed for Klyvaron. Ordinary chat input is never model training and is never auto-ingested. Only consult the remaining instructions if you intentionally use this separate legacy research tool on your own machine:

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
| Optional provider model list is empty or `/api/ready` says `setup_required` | No provider connection is configured for model-backed Chat | The built-in Klyvaron text processor remains available. To use a provider, follow §7 — Provider Settings, then **Test connection & refresh models** |
| `400 endpoint_blocked` when saving a provider | A loopback or private base URL whose exact origin is not trusted | For ComfyUI or another local endpoint, set `AETHERIS_TRUSTED_ORIGINS` to the exact origin and restart Core; do not expose an unauthenticated service to the LAN/Internet |
| Sign-in succeeds, then the app returns to the sign-in page | The session cookie is not being sent — the app is inside another site's iframe and the cookie is `SameSite=Strict` | Start Core with `AETHERIS_COOKIE_SAMESITE=none` and `AETHERIS_COOKIE_SECURE=true`; see [docs/20](20-accounts-and-sign-in.md) |
| `502 invalid_stream` on every message | The base URL is missing `/v1`, or the gateway answers with an error page | §7 — check the two `curl` calls against the gateway directly |
| Web UI shows "Core service unreachable" | Core not running, or the proxy target is wrong | Start the core; check `AETHERIS_CORE_URL` |
| UI works locally but not behind a proxy | Dev server rejecting the host | Already handled: `allowedHosts: true`. Check the proxy forwards `/api` |
| `No module named pytest` | System interpreter has no pytest | `AETHERIS_PYTHON=/path/to/venv/bin/python` |
| `Database opened` / sqlite errors | Node < 22.5 | Upgrade Node; `node:sqlite` is required |
| Image says `provider_not_configured` | No usable image connection is saved | §8 — add and test a listed cloud image provider or an already-running trusted ComfyUI service |
| Video refuses with `needs_hardware` | No local video runtime | Expected on this hardware class. The refusal never substitutes a still image |
| Fabric `POST /pipeline/run` returns `failed` | Trained MRR below the 0.60 release floor | Correct behaviour. Raise `epochs`; see the model card's release requirements |
| Fabric returns 413 | Body over 1 MB | Expected; this service takes small JSON commands, not datasets |
| A blank `AETHERIS_RUNTIME_POLICY` | — | Fails safe to `strict_offline` and records a warning. It never fails open |

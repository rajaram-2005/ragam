# Model catalog v1: discovery without false readiness

## What works

`catalog/registry.mjs` and `catalog/sources.mjs` add a bounded metadata registry,
independent of `router/registry.mjs`. The Chat area's **Model catalog** panel searches
it, while **Registered models** still represents the operational routing inventory.
There is no sixth area and no automatic “install/use” action on a catalog record.

Sources implemented at protocol level:

| Adapter | Metadata operation | Evidence / limitation |
|---|---|---|
| `catalog.klyvaron/1` | Startup-verified local library inventory | Uses existing first-party artifact metadata; no network. Catalog status is still separate from runtime admission. |
| `catalog.huggingface/1` | `GET /api/models?limit=100&full=true&cardData=true` | Bounded first page; advertised revision, task, card licence and base relationships. No weight downloads or live Hub qualification in this sandbox. |
| `catalog.ollama/1` | `GET /api/tags` | Installed-runtime listing shape; digest, disk bytes, family, quantization and explicit cloud markers. Does not infer chat/tool support or local inference from a name. |
| `catalog.litellm/1` | `GET /models` relative to configured API base | LiteLLM/OpenAI-shaped accessible-model listing, not pricing/capability or successful inference evidence. |
| `catalog.openai-compatible/1` | Same bounded model-list protocol | Private/compatible endpoints must be deliberately configured. Compatibility with one endpoint does not qualify its entire runtime. |

Adapters use original code against inspected interfaces. No LiteLLM/Hub dependency
or enterprise source is bundled. Controlled loopback servers test the actual HTTP
path; this is not a claim that a real LiteLLM deployment or every provider works.

## Records and trust

The schema is `aetheris.model-catalog/1`. Identity hashes the source ID, canonical
model ID and revision, preventing collisions across sources/revisions. Records carry
source identity, fetch time and a hash of the normalized snapshot. Source descriptors
also report adapter version, endpoint origin, refresh policy, TTL and coverage.
These hashes provide reproducibility/integrity references, **not authentication** of
publishers or proof of model quality. Source-supplied metadata is untrusted data.

Absent information remains null or an empty “not reported” list: context/output
limits, tools, structured output, hardware, pricing, quotas, privacy and benchmarks
are not guessed. `/v1/models` does not establish chat, image, video or tool support.
A Hub `text-generation` tag is not a verified instruction-following/chat capability.
Publisher strings are source assertions, not authenticated identities.

Licence identifiers are displayed with `review: not_reviewed`; restrictions remain
unknown. This is **not** SPDX/legal clearance. Installation and inference readiness
remain `unknown` / `unverified`, even if a remote body tries to set them to ready.
`lastVerifiedAt` is null; `fetchedAt` is a metadata retrieval time, not a benchmark
or inference-verification time. Downloads, use-case restrictions and installation
consent require separate future checks.

## Configure sources on the Core host

Only Klyvaron inventory is automatically registered/refreshed. Other catalogs are
opt-in, including metadata from an already configured Ollama daemon. Create an
operator-owned file **outside Git**, for example:

```json
{
  "schema": "aetheris.catalog-sources/1",
  "sources": [
    { "id": "ollama-catalog", "kind": "ollama", "baseUrl": "http://127.0.0.1:11434", "ttlMs": 60000 },
    { "id": "hub", "kind": "huggingface", "baseUrl": "https://huggingface.co" },
    { "id": "gateway", "kind": "litellm", "baseUrl": "http://127.0.0.1:4000/v1", "tokenFile": "gateway-token.txt" }
  ]
}
```

Set `AETHERIS_MODEL_CATALOG_FILE=/absolute/path/to/catalog-sources.json`. The
configuration is read at startup and rejected if malformed. No remote refresh runs
at startup. A `tokenFile` path is relative to the configuration file's directory;
keep it protected and outside source control. The token is read only in Core,
passed as a Bearer header only to the configured metadata endpoint, and omitted
from config responses, catalog records and telemetry. Do not use `VITE_*` secrets.
No API allows an HTTP caller to register URLs, change source credentials or install
models. Configured URLs require HTTPS or loopback HTTP, without userinfo, query
strings or fragments. Source IDs must be unique; `klyvaron` is reserved.

For external sources, both are required:

1. A non-Strict-Offline server policy and an appropriate egress allowlist, e.g.
   `AETHERIS_RUNTIME_POLICY=hybrid` and `AETHERIS_ONLINE_ALLOWLIST=huggingface.co`.
2. Explicit authorization on that refresh request (`authorizeNetwork: true`).

**Strict Offline blocks external catalogs even with authorization.** LiteLLM and
generic model gateways remain external catalog operations even at a loopback URL:
they may perform upstream discovery. Only the dedicated loopback Ollama listing
adapter is permitted without external consent. This does not install, authorize or
run an online model. Search text, prompts and documents are never sent by these
metadata adapters; configured metadata requests contain no task content.

This Core currently lacks full multi-user authentication/organization isolation.
Run it in a trusted local environment, not as a publicly exposed credential-bearing
catalog service. The checkbox is operation consent, not an identity/authentication
system. Daemons and proxies are separate trust boundaries: the Core fetch guard
cannot firewall arbitrary software running on the host. Disable or network-isolate
remote features in local runtimes where strict device-wide isolation is required.

## API and bounded refresh behaviour

- `GET /api/models/catalog?q=...&task=...&source=...&limit=100&offset=0`
  searches **cached metadata in Core only**. It never triggers upstream search.
- `POST /api/models/catalog/refresh` with
  `{"sourceId":"gateway","authorizeNetwork":true}` refreshes a configured source.
- `/api/models` and `/api/models/probe` remain separate inference inventory/probe
  operations. Catalog refresh does not call `register`, `upsert`, download or infer.

Limits: 16 source slots; up to 14 optional file-configured sources; 500 records per
source; 100 results per search page; 256 search characters; 2 MiB response body;
64 KiB configuration; 8 KiB credential file. Default source TTL is 24 hours; allowed
TTL is 1 second–30 days. The default HTTP deadline is 8 seconds and covers body reads
as well as headers. Redirects and remote pagination links are not followed. Hub
coverage is explicitly `bounded_page`, not the entire Hub. `complete_response`
means only that the returned response was consumed, not all models/providers exist
in that response or are accessible to every user.

There is one refresh at a time per source (`catalog_busy` on overlap), no automatic
retry loop and no scheduled crawler. HTTP disconnect/shutdown cancels metadata
reads. Whole snapshots are validated before replacement. Failure retains the last
good snapshot, marks it stale and records a sanitized error code; upstream error
text is never echoed into metadata/telemetry. The public result never includes the
configured credential, even if a provider echoes it as metadata. Successful refresh
replaces that source's old listing, including an intentionally empty response.

**The cache is in memory, not durable across restart.** Restart reconstructs the
local inventory and requires explicit refresh for other sources. Persistence,
source pagination, signed publisher evidence, fine-grained legal review, freshness
scheduling, adaptive rate-limit backoff and broad provider qualification remain
future increments. No catalog metadata is used as a model quality improvement.

## Verification

```bash
node --test services/core/test/catalog.test.mjs
npm run test:web
AETHERIS_PYTHON=/absolute/path/to/python-with-numpy-and-pytest npm run verify
```

Twenty Core tests cover schema honesty, provenance identity, atomic replacement,
TTL, search, source/body bounds, opt-in networking, Strict Offline, three remote
protocol shapes, credential redaction, redirects, deadlines, cancellation, operator
configuration, real Core HTTP and cloud-model exclusion. Three Web tests cover the
API contract, in-Chat wiring/consent and actual server-rendered markup. They are not
browser automation, real provider inference tests or model benchmarks.

# Third-party notices

Aetheris Omni integrates work from three upstream repositories and depends on a
small set of permissively licensed libraries. This file records what was taken
from where, under what licence, and — just as importantly — **what was
deliberately not copied**.

Every commit hash, version number and licence string below was read from the
actual checked-out source or installed package metadata, not from a README claim.

---

## 1. Upstream repositories

### 1.1 Aetheris- (Repository A)

| | |
|---|---|
| URL | https://github.com/rajaram-2005/Aetheris- |
| Licence | **MIT** |
| Copyright | `Copyright (c) 2026 RAJARAM K` |
| Commit reviewed | `bed29f4f98eb0be8b7bb7ae2488607765579dbfe` (2026-10-04) |
| Baseline | `npm test` → 37 pass / 0 fail |

**What was taken**

- **Visual identity**, carried into `apps/web/src/styles.css`: the `:root` design
  tokens (`--bg: #090c0e`, `--surface: #0e1316`, the mint/violet/gold/blue/coral
  accent pairs, `--radius: 13px`), the Manrope + DM Mono type pairing, the
  `.app-shell` backdrop (two radial gradients over a fixed 52 px grid overlay at
  0.28 opacity), the 250 px `.sidebar`, the `.brand-mark` (rotated core dot plus
  two orbit ellipses), the `.nav-item` active treatment (mint text over a
  left-to-right mint gradient with a glowing 2 px right edge) and the
  `.fabric-status` card.
- **Server-side patterns** from `server/agentGateway.mjs`, the only genuinely
  server-side module in that repository. Its configuration-loading, redaction and
  composition approach informed `services/core/src/config.mjs` and
  `services/core/src/app.mjs`. The code was re-implemented against this project's
  interfaces rather than copied wholesale.

**What was not taken**

- `src/runtime/` (~65 modules) is in-browser simulation. It was **not** ported.
  Where an equivalent capability exists here it is a real server-side
  implementation (egress enforcement, media validation, plugin permissions, MCP
  schema validation, the God Core lifecycle), and where it does not exist the gap
  is recorded as a limitation rather than filled with a simulation.
- The twelve-entry `NAV_ITEMS` list (`src/main.jsx:73-86`) was **reduced to five**
  product areas. The mapping is recorded in `apps/web/src/areas.js`.

The MIT licence text is reproduced in §4 below.

### 1.2 sparsiz (Repository B)

| | |
|---|---|
| URL | https://github.com/rajaram-2005/sparsiz |
| Licence | **Unlicense** (public domain) |
| Commit reviewed | `76ec6f0f0f501ea9fbf99f0769ef224d3dbc0d69` (2026-09-28) |
| Baseline | `pytest tests/ -q` → 14 pass / 1 fail (`test_saram.py::test_compression`, missing torch) |

**What was taken — concepts, not code**

- The **failure taxonomy** structure, re-implemented in
  `services/fabric/fabric/taxonomy.py`.
- The **compute-optimisation formula** `Q(x)` and its tier boundaries, adopted as
  the scoring model in `services/fabric/fabric/metrics.py`.
- The **failure-memory recurrence** `E_{t+1} = E_t ∪ F_t`, implemented in
  `services/fabric/fabric/failure_memory.py`.
- `faisanth.py` contains real mathematics (YBus construction, edge and node cost)
  and is the intellectual ancestor of the model router's candidate scoring in
  `services/core/src/router/registry.mjs`. The scoring itself was replaced.

**What was not taken**

- **No files were copied.** The training stack upstream is randomised: 70 of 176
  files import `random`, none import `torch`, none import `numpy` at module level,
  and `evaluation.py:52`, `dataforge.py:54-61` and `distillation.py:55-61` are
  labelled mocks in the source itself. It therefore cannot supply a real
  Aetheris Lite model, and `services/fabric` was written from scratch (NumPy only)
  instead.
- The 35 byte-identical duplicate file pairs found in that repository were not
  reproduced here.

Because the work is Unlicensed (public domain), no attribution is legally
required. It is recorded anyway, because the provenance of an idea matters for
reviewing it.

### 1.3 freellmapi (Repository C)

| | |
|---|---|
| URL | https://github.com/tashfeenahmed/freellmapi |
| Licence | **MIT** |
| Copyright | `Copyright (c) 2026 Tashfeen Ahmed` |
| Commit reviewed | `65ec96df6450224a95a0eabfff8b41b394b2396f` (2026-10-11, 33,138 stars) |
| Baseline | `npm test` **not run** — requires a native `better-sqlite3` build unavailable in this sandbox. Contracts were read from source instead and are recorded as read-from-source, not as verified-by-execution. |

**What was taken — nothing. No files were copied.**

The gateway is consumed as a **separately versioned external service** over its
documented `/v1` HTTP surface, from `services/core/src/providers/freellmapi.mjs`.
This was a deliberate architectural choice: copying a 33k-star TypeScript service
into this repository would have duplicated its dependency surface and made
Aetheris responsible for its maintenance.

Contracts confirmed by reading its source:

- Chat/images/videos under `/v1`; error envelope `{error:{message,type,code?}}`
  with `type ∈ invalid_request | authentication | rate_limit | server`, status
  clamped to 400–599 else 502.
- Image responses are JSON: `{created, data[], model, provider}`.
- **Video responses are a raw binary MP4**, not JSON — so cancellation means
  aborting the request, and validation must sniff the container.
- `VIDEO_PLATFORMS = {pollinations, huggingface}` — **two** platforms, against
  **eight** for images. `keys.ts:921` states video is unsupported on custom
  endpoints. Hence: chat support does **not** imply video support.

Its upstream note "*Personal experimentation only*" is reproduced here because it
bears on deployment decisions, not on licence compatibility.

The MIT licence text is reproduced in §4 below.

Aetheris remains fully functional when this service, a provider, or its external
catalogue is unavailable: every capability that depends on it degrades to an
audited refusal with an explicit limitation.

---

## 2. Runtime dependencies (shipped in the browser bundle)

Only these reach production. The bundle is 218.97 kB (66.82 kB gzipped), a single
chunk, and `apps/web/test/structure.test.mjs` fails if it grows past 400 kB.

| Package | Version | Licence | In the bundle? | Copyright |
|---|---|---|---|---|
| react | 18.3.1 | MIT | yes | Copyright (c) Meta Platforms, Inc. and affiliates |
| react-dom | 18.3.1 | MIT | yes | Copyright (c) Meta Platforms, Inc. and affiliates |
| scheduler | 0.23.2 | MIT | yes (`react-dom` dependency) | Copyright (c) Meta Platforms, Inc. and affiliates |
| loose-envify | 1.4.0 | MIT | **no** — build-time shim | Copyright (c) 2015 Andres Suarez <zertosh@gmail.com> |
| js-tokens | 4.0.0 | MIT | **no** — `loose-envify` dependency | Copyright (c) 2014-2018 Simon Lydell |

Only `react` and `react-dom` are declared as dependencies; `scheduler`,
`loose-envify` and `js-tokens` are their transitive dependencies. `loose-envify`
rewrites `process.env.NODE_ENV` at build time and does not survive into the
production bundle — verified by searching the built artifact for its identifiers
and for `process.env.NODE_ENV` (both absent), while `scheduler`'s
`unstable_scheduleCallback` and `MessageChannel` are present. All five are listed
because a licence obligation follows the dependency tree, not the bundle.

`services/core` has **zero** npm dependencies. It runs on Node's standard library
only, including `node:sqlite`.

`services/fabric` has **one** runtime dependency:

| Package | Version | Licence | Copyright |
|---|---|---|---|
| numpy | 2.1.3 | BSD-3-Clause | Copyright (c) 2005-2024, NumPy Developers |

---

## 3. Development and build dependencies (not shipped)

All but the five packages in §2 are build-time tooling: Vite, Rollup, esbuild,
Babel, PostCSS and their transitive dependencies.

### How many packages there are

Two different numbers are correct, and conflating them is how a dependency
inventory becomes wrong on someone else's machine.

| Measure | Count | Portable? |
|---|---|---|
| Entries in the committed `package-lock.json` | **109** | yes |
| …of which platform-independent | 59 | yes |
| …of which platform-specific native binaries | 50 | yes |
| Actually installed on this host (linux/x64, glibc) | 62 | **no** |

The installed figure is host-specific because 50 entries are per-platform native
binaries (`@esbuild/darwin-arm64`, `@rollup/rollup-win32-x64-msvc`, …) and npm
selects among them at install time. Four match linux/x64:
`@esbuild/linux-x64`, `@napi-rs/lzma-linux-x64-gnu`,
`@rollup/rollup-linux-x64-gnu` and `@rollup/rollup-linux-x64-musl`. The lockfile
carries `os` and `cpu` fields but **no `libc` field**, so npm cannot exclude the
musl variant from the lockfile alone and resolves it by probing the system. A
glibc host installs 62; a host where npm cannot distinguish the two may install
63. The lockfile counts are therefore the ones stated as fact, and the installed
count is stated as a property of this machine.

### Licence distribution

Across all **109** lockfile entries, read from each package's own metadata — so it
covers packages that are not installed on this host but would be on another:

| Licence | Count | Examples |
|---|---|---|
| MIT | 101 | vite, rollup, esbuild, postcss, @babel/*, @vitejs/plugin-react, browserslist, debug, json5, nanoid, ms, jsesc, react-refresh, … |
| ISC | 5 | electron-to-chromium, lru-cache, picocolors, semver, yallist |
| Apache-2.0 | 1 | baseline-browser-mapping |
| CC-BY-4.0 | 1 | caniuse-lite (**data**, not code) |
| BSD-3-Clause | 1 | source-map-js |

Every entry declares a licence; none is unknown. Reproduce this table from the
committed lockfile — no install step, so the result is identical on any host:

```bash
node -e "
const l=require('./apps/web/package-lock.json');
const e=Object.entries(l.packages).filter(([k])=>k!=='');
const by={};
for(const [k,v] of e){const x=v.license||'(none)';(by[x]??=[]).push(k.replace('node_modules/',''))}
for(const [x,n] of Object.entries(by).sort((a,b)=>b[1].length-a[1].length))
  console.log(x.padEnd(12), String(n.length).padStart(3), '|', n.slice(0,6).join(', '));
console.log('total:', e.length,
  '| platform-specific:', e.filter(([,v])=>v.os||v.cpu).length)"
```

`services/core/test/docs.test.mjs` runs the equivalent assertions in CI, including
that no entry anywhere in the lockfile carries a copyleft licence and that none is
missing a licence declaration.

`caniuse-lite` is CC-BY-4.0 **data** consumed by `browserslist` at build time to
select transpilation targets. It is not redistributed in the bundle and no caniuse
data appears in the shipped output. Attribution is recorded here in any case.

### Other components

`services/core` has **zero** npm dependencies. It runs on Node's standard library
only, including `node:sqlite`. CI asserts this property, because it is what keeps
the core auditable and free of a supply chain.

`services/fabric` has **one** runtime dependency:

| Package | Version | Licence | Copyright |
|---|---|---|---|
| numpy | 2.1.3 | BSD-3-Clause | Copyright (c) 2005-2024, NumPy Developers |

Python test tooling (development only, not redistributed):

| Package | Version | Licence |
|---|---|---|
| pytest | 8.3.4 | MIT |
| pluggy | 1.6.0 | MIT |
| iniconfig | 2.3.1 | MIT |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |

---

## 4. Licence texts

The authoritative copies are checked into [`licenses/`](./licenses/) so this
project can be redistributed without re-fetching anything:

| File | Source | Size |
|---|---|---|
| `licenses/aetheris-MIT.txt` | `Aetheris-/LICENSE` @ `bed29f4` | 1,066 B |
| `licenses/freellmapi-MIT.txt` | `freellmapi/LICENSE` @ `65ec96d` | 1,071 B |
| `licenses/sparsiz-Unlicense.txt` | `sparsiz/LICENSE` @ `76ec6f0` | 1,211 B |
| `licenses/numpy-BSD-3-Clause.txt` | `numpy 2.1.3` dist-info `LICENSE.txt` | 47,755 B |

The texts below are reproduced verbatim from those files.

### MIT — Aetheris-

```
MIT License

Copyright (c) 2026 RAJARAM K

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### MIT — freellmapi

```
MIT License

Copyright (c) 2026 Tashfeen Ahmed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Unlicense — sparsiz

```
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org>
```

### BSD-3-Clause — NumPy

NumPy's distributed `LICENSE.txt` is 47 KB because it bundles the licences of its
individual components. The complete file is preserved in `licenses/`; the NumPy
terms themselves are:

```
Copyright (c) 2005-2024, NumPy Developers.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    * Redistributions of source code must retain the above copyright
       notice, this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above
       copyright notice, this list of conditions and the following
       disclaimer in the documentation and/or other materials provided
       with the distribution.

    * Neither the name of the NumPy Developers nor the names of any
       contributors may be used to endorse or promote products derived
       from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## 5. Compatibility conclusion

This repository (`ragam`) is MIT, "Copyright (c) 2026 RAJARAM K".

- MIT ← MIT: compatible, notice preserved above.
- MIT ← Unlicense: compatible; public-domain work may be relicensed under MIT.
- MIT ← BSD-3-Clause: compatible, notice preserved above.
- MIT ← Apache-2.0 (build-time only, not redistributed): compatible for build
  tooling; no Apache-2.0 code is distributed in any artifact.
- CC-BY-4.0 (build-time data only, not redistributed): attribution recorded.

**No GPL, AGPL or LGPL code is present anywhere in the dependency tree.** No
copyleft obligation is triggered by building, running or redistributing this
project.

---

## 6. Model weights — an open item, stated explicitly

**No model weights are redistributed, downloaded or vendored by this project.**
`.gitignore` excludes `*.gguf`, `*.safetensors` and `checkpoints/`.

The one first-party artifact, `aetheris-lite-retriever@0.1.0`, is trained from
scratch by `services/fabric` and carries **no base checkpoint** — there is no
third-party weight licence to clear for it. Its own licence (MIT) and full
provenance are recorded in
[`../docs/model-cards/aetheris-lite-retriever-0.1.0.md`](../docs/model-cards/aetheris-lite-retriever-0.1.0.md).

Any *future* Aetheris Lite specialization built by fine-tuning a pretrained base
(Mistral, Qwen, Llama, Gemma, DeepSeek or similar) **must** have that base's
licence recorded in its model card before release. Several of those families carry
community-licence or acceptable-use restrictions that are *not* MIT-compatible and
would constrain redistribution. None of them could be downloaded on the host used
for this work (`huggingface.co` is unreachable), so no such licence was evaluated
— and consequently **no claim is made that any Aetheris model matches or beats
them**. See [`../docs/06-benchmarks.md`](../docs/06-benchmarks.md).

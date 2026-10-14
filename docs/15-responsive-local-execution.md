# Responsive local CPU execution

This increment changes how **first-party Klyvaron text artifacts** execute in Core.
It does not introduce useful assistant weights, a native mobile runtime, a GPU
backend or a newly qualified Lite / Pro / Max hardware profile.

## Execution contract

- **One shared CPU worker per Core app**, with at most one admitted generation.
  Concurrent requests fail with `local_busy` (503); prompts are not placed in an
  unbounded queue. No remote service is invoked as a fallback.
- The worker runs the same float32 / resident-int8 kernels as the synchronous
  numerical reference path. It loads from the local managed artifact directory;
  the parent does not structured-clone model arrays into the worker.
- Streaming delivers incremental text. At most **one unacknowledged text chunk**
  is in flight from the worker. A partial stop-sequence prefix is withheld until
  it can safely be emitted, so streamed text agrees with the final completion.
- HTTP SSE writes respect Node's backpressure (`write()` / `drain`). Cancellation
  while waiting for a reader removes the drain/close/abort listeners.
- The default first-party provider deadline is **120,000 ms**, measured over
  loading, generation and consumer backpressure. It is a wall-clock limit, not a
  per-token limit or a minimum performance guarantee.
- Cancellation and deadlines **terminate the worker**, including a long or
  non-cooperative forward pass. They report `cancelled` (499 internally) or
  `timeout` (504), not a successful completion. A disconnected client cannot
  receive an error frame; Core still stops its local work.
- Terminated and abandoned streams are not counted as completed generations.
  A subsequent request loads a new worker/model. Late cleanup from an old,
  timed-out consumer cannot terminate a newer request's worker.
- `/api/chat` and `/api/chat/stream` link real socket disconnects to an AbortSignal.
  An HTTP caller cannot supply its own serialized replacement for that signal.
- **Stop generation** cancels both streamed and non-streamed ordinary Chat.
  The current Chat view retains its draft and any received partial text, labels
  cancellation, and permits a local retry. Unmount also aborts the request.
  This is not a persistent draft store or a resumable model/KV checkpoint.
- The web SSE reader cancels/releases the response body when consumption ends.
  EOF without `done` or `error` is `stream_interrupted`, never silent success.

## Verification is not residency

Core still opens and validates each installed artifact **at startup**, including
its weight archive. This remains synchronous startup work and transient memory
allocation. It is **not** lazy verification, constant startup RAM, a measured
startup improvement or an assurance that V8 immediately returns memory to the OS.

After verification the app's providers retain metadata, not all model weight
arrays. The shared worker then:

1. Loads the requested artifact on first use, independently verifying its bytes.
2. Checks both the weights digest and a digest of the parsed manifest against
   the identity pinned during startup verification. Changes produce
   `artifact_changed`; archive corruption produces the loader's own refusal.
   Restart/re-open the library after an intentional artifact update.
3. Reuses its one verified resident model for subsequent requests. A cached
   model is the originally verified in-memory version; disk files are not
   rehashed on each token or each cache hit.
4. Terminates the old worker **before** loading a different model.
5. Terminates after **30 seconds idle** by default, on abort/deadline, or on close.
   Idle workers/timers do not keep a command-line process alive.

`/api/ready` exposes `klyvaron.execution`: `cold`, `running`, `idle` or `closed`,
active/resident artifact paths, logical resident weight payload bytes, capacity
and queue depth. The legacy `klyvaron.loaded` list is **startup-verified inventory**,
not a list of permanently resident models. Provider descriptors distinguish
`weightPayloadBytes` from `residentWeightBytes` and identify `local_cpu_worker`.
These are logical residency reports, not process RSS, peak memory, OS cache size,
or proof that asynchronous teardown has already returned every byte to the OS.

A worker thread is an execution boundary, **not a security sandbox**. The worker
has no inference networking code and disables its global `fetch`; that does not
claim to sandbox arbitrary future native modules or user-supplied JavaScript.
Only the fixed, first-party worker module executes here.

## APIs retained and limitations

- `KlyvaronRuntime.generate()` remains synchronous for parity tests and standalone
  benchmarks. `generateSteps()` adds a pull-based interface without changing the
  numerical kernels.
- A library caller can still supply an in-memory runtime directly to
  `KlyvaronProvider`. That path yields cooperatively **between** steps; it cannot
  interrupt a single synchronous forward pass. The app's installed models use
  the worker-backed path instead.
- Provider throughput/latency observations now include worker load and consumer
  waiting. They are **not** interchangeable with kernel-only benchmark results.
  Worker messaging has overhead; no speedup claim is made.
- SSE completion metadata includes actual first-party stopping reason, token
  usage and the base-model limitation. Providers without that metadata report
  null instead of invented measurements. Stop-token generation counts still
  include tokens removed from displayed text.
- Completed streamed assistant turns are recorded when a session exists.
  Cancelled partial text is retained in the current UI, not persisted as a
  completed assistant turn.
- This single-slot executor is not a GPU reservation manager. It does not
  qualify Android/iOS, enforce every managed write on native platforms, prove
  mobile battery/thermal limits, or satisfy useful-assistant release gates.
- Strict Offline, Local / Hybrid / Online authorization and the measured-hardware
  policy remain in force. No training, GPU sharing or data upload is introduced.

## Repeatable verification

```bash
node --test services/core/test/klyvaron-runtime.test.mjs \
  services/core/test/klyvaron-quantized.test.mjs \
  services/core/test/klyvaron-execution.test.mjs \
  services/core/test/klyvaron-app.test.mjs
npm run test:web
# Set this to an interpreter with NumPy and pytest:
AETHERIS_PYTHON=/absolute/path/to/python npm run verify
```

The execution suite has **16 tests**. It exercises real worker threads, local
artifact reloads, float32/int8 parity, one-model caching/switching, early stream
closure, pre-aborted requests, backpressure, busy refusal, deadline reclamation,
manifest/weight tampering, idle expiry, worker failure and shutdown. Actual HTTP
requests cover health responsiveness, JSON/SSE disconnects, stop-sequence privacy
and an error rather than `done` on deadline.

The non-cooperative forward-pass test deliberately stalls a test worker inside
`logits()` for up to 60 seconds. The production deadline/termination machinery
interrupts it. This is **fault-injection evidence**, not measured model latency.
A controlled response emitter tests the `write() === false` / `drain` path; it is
not a network-throughput benchmark. Web API tests use real ReadableStream objects;
UI control wiring is source-tested, not claimed as browser automation.

The complete repository verification at this increment is **1,136 passing tests**:
489 Core, 72 Web and 575 Fabric, plus a successful web production build.
The existing int8 CPU smoke report remains a historical measurement of the source
hashes it records, not a benchmark of this new worker/HTTP execution path.

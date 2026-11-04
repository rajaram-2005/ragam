# Model-independent Klyvaron processing

Klyvaron's built-in text-processing path does not require an AI model, model weights, foundation training, fine-tuning, model download, provider account, or network access. It runs deterministic algorithms in the Core process and uses the signed-in account's own local knowledge and memory stores only when the user explicitly enables them.

This is a processing engine, not a claim of general intelligence. It does not provide learned open-ended language reasoning, infer intent reliably, or guarantee correctness. It returns source text and measurable operations where possible, and reports when no local evidence was found.

## Tiers are resource profiles

All tiers use `klyvaron-deterministic-v1`; the profile changes bounded context and workflow resources, not model identity or training:

| Tier | Maximum input | Tasks per workflow | Extractive summary | Retrieval | Concurrent task slots |
|---|---:|---:|---:|---:|---:|
| Lite | 16,000 characters | 2 | 4 sentences | 4 results | 1 |
| Pro | 64,000 characters | 5 | 8 sentences | 8 results | 3 |
| Max | 100,000 characters | 8 | 12 sentences | 12 results | 4 |

These are software limits, not claims that Max has better reasoning. They can be changed only with measured resource and responsiveness evidence. Multi-task requests are bounded and may run with the profile's concurrency limit; each selected task receives the same input independently. Tasks are not chained, and one task's output is not treated as another task's input.

## Current deterministic tasks

- **Inspect:** character, word, line and sentence counts, headings, code-fence count, text digest, and a basic structure label.
- **Summarize:** select and rank original sentences, preserving source wording and offsets. It is extractive, not paraphrased.
- **Extract:** find email addresses, URLs, ISO dates, numeric strings, Markdown headings, list items and fenced-code counts with patterns. It does not infer people, entities or meaning.
- **Outline:** return Markdown headings/list items, or selected original sentences when those structures are absent.
- **Compare:** compare unique token sets and report overlap. It is lexical, not semantic and not a correctness judgement.
- **Calculate:** evaluate bounded arithmetic (`+`, `-`, `*`, `/`, parentheses and unary signs) with a parser; no dynamic evaluation.
- **Retrieve / answer:** search the account-local BM25 index and, optionally, approved memories. Results are source excerpts with citations, not generated answers. No evidence means no inferred answer.

Text and locally extracted text from supported documents can be processed. The built-in engine does not inspect binary images, audio or video, generate media, perform OCR/ASR, or execute arbitrary code. Those remain distinct capabilities and must not be implied by a tier label.

## Persistence, privacy and API

`POST /api/klyvaron/process` requires an authenticated account and accepts `tier`, `input`, a task list, and explicit `useKnowledge`, `useMemory`, and `saveToKnowledge` booleans. Unknown request fields are rejected. Input is bounded by the selected tier; the request body is limited to 512 KiB. Knowledge and memory lookup are opt-in per request and scoped to the authenticated account. Supplied text is not persisted unless `saveToKnowledge: true`; a failed workflow is not saved. An optional session ID saves the processed user/assistant turns to that account's session store. The engine makes no egress calls.

`GET /api/klyvaron/processor` reports profiles and supported tasks. Responses identify `modelUsed: false`, `weightsUsed: false`, and `networkUsed: false`, and include the limitations that apply.

Optional BYOK/provider chat, legacy first-party model artifacts, and model release governance remain separate integrations. They are not prerequisites for this processor, and an optional provider response is not represented as deterministic Klyvaron processing.

## Status

The deterministic processor, authenticated route, Chat engine selector, local knowledge/memory access, and explicit-save path are implemented and covered by tests. This does not establish reliable open-ended conversation or universal understanding. Broader workflows, richer parsers, OCR/ASR, image/video understanding, and real-world task success require separate implementation and evaluation.

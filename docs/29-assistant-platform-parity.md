# Assistant platform parity roadmap

**Scope:** Build an original, local-first chat workspace that can use the user's explicitly selected OpenAI/ChatGPT, Anthropic/Claude, Google/Gemini, xAI/Grok, and other supported endpoints. The target is comparable workflows, not a pixel-for-pixel copy of another service. No vendor branding, assets, proprietary source, or unsupported feature claims are copied.

This is a staged product plan, not a claim that every feature listed below already exists. Provider API use is always user-initiated and may incur vendor charges. Tests use deterministic fixtures; they do not establish live-provider behavior.

## What is already in the engine

| Capability | Current state |
|---|---|
| Provider setup and model choice | Provider Settings stores the user's own connection, exposes the models returned by that connection, separates saving from explicit connection testing, and requires explicit model selection. API keys are not returned to the browser. |
| Chat interaction | Streaming responses, Stop, copy, retry of failed drafts, temperature/token controls, response styles, and a sample action that only fills the composer. Sending remains an explicit user action. |
| Saved history | Local Core stores sessions and turns on request. The Chat history panel can search, delete, open, and continue a saved session. On continuation, the UI says the full visible transcript goes to the currently selected model; the model used for historical turns is not recorded. |
| Context and tools | Local conversation recall, optional approved memory, local knowledge retrieval, reviewed text procedures, and separate Plugins/MCP product areas exist. Local retrieval is not web search; Plugins/MCP do not imply automatic tool use in chat. |
| Voice and media | Chat supports local text/PDF extraction and consent-gated image/audio/video transfer only through a compatible provider wire. Expanded recording, reviewed local transcription and spoken replies are available only when verified Klyvaron voice artifacts are installed. Image and Video remain separate product areas. |
| Navigation and deployment | The five product areas remain Chat, Image, Video, Plugins, and MCP. Each user runs an independent Docker installation and keeps its storage locally. |

## Gaps and delivery phases

### 1. Chat workspace organization — implemented in this phase

- Create browser-local project labels, assign and filter saved conversations, pin/unpin, and set a custom display title.
- Reuse local saved sessions; do not copy turns or prompt content into browser organization metadata.
- Clearly disclose that organization labels are browser-local, do not sync across browsers, and are not sent to a model.
- Acceptance: no Core migration, provider request, billing event, or new navigation area; bounded and validated browser metadata; graceful behavior when browser storage is unavailable.

### 2. Capability-aware provider experience — partial

- Chat now displays the selected model's stored catalogue evidence (input/output, streaming, image-input and tool fields) and its provenance when available; otherwise it says capability is unknown rather than inferring from the model name.
- Keep provider access, model listing, inference verification, and feature availability separate. A successful connection test is not proof of image, search, audio, tool, or context-window support.
- Never select a fallback model or provider silently. Provider-specific API features are wire-gated and opt-in; the selected model may still reject a feature, and no fallback occurs.


### 3. Search and tool use — adapter-specific, explicit opt-in

- Chat can run a user-selected connected MCP tool after a visible permission check. Remote arguments require per-call approval; results are shown as untrusted data and enter the chat draft only after a separate user action.
- Native search is available through provider-native request shapes: Gemini `google_search`, OpenAI and Azure OpenAI Responses API `web_search`, OpenRouter's Responses API `openrouter:web_search`, and Anthropic Messages `web_search_20250305`. Other OpenAI-compatible endpoints use the OpenAI Responses `web_search` contract only when they implement it; an unsupported endpoint fails explicitly without a Chat Completions retry. A separate per-turn checkbox is required before the search request is sent. The provider/search service may receive the query and prompt context and may charge for use; provider-returned URLs/titles are shown as sources without invented citations.
- OpenAI Chat Completions, Azure OpenAI, documented OpenAI-compatible Chat wires, Anthropic Messages, and Gemini accept selected MCP function schemas. The provider adapter converts these to its documented request shape. A per-turn checkbox authorizes sharing the names, descriptions and schemas. Model responses are proposals only; no tool is called until the user separately runs it through the manual MCP gate.
- When a supported model returns a function call, Ragam displays its name and arguments as an untrusted proposal. Core validates that the proposal matches a schema offered for that request. Ragam never executes it automatically; the user must invoke a tool through the manual MCP runner, inspect its gate, approve any remote transfer, and choose whether to add the result to the draft.
- Local memory/knowledge search remains distinct from internet search. Keep Plugins and MCP in their existing areas; no sixth navigation item.

### 4. Chat files and multimodal inputs — implemented with per-wire limits

- Chat accepts up to three text, PDF, image, audio, or video files. Text files are capped at 200 KiB each; PDFs/media at 3 MiB each; extracted text at 80,000 characters; binary media at 5 MiB per request. PDF.js extracts up to 40 pages locally, with no scanned-image OCR. The user reviews local previews/extracted text; selection never uploads.
- PDF and text content is sent as text only on Send. Binary media is sent only on Send after a separate per-turn transfer approval, supported provider-wire check, and bounded Core request. Supported encoding is adapter-specific: OpenAI-style/Anthropic wires accept images; Gemini accepts images, audio, and video. Unsupported modalities are refused without fallback. Binary media bytes are excluded from saved history; history contains a placeholder and asks the user to reattach media for a future turn.
- Model-specific modality may still be unknown or refused. Keep type/signature/size checks and a visible list of exactly what leaves the local app. Never silently include files or local knowledge/memories; those context transfers require their own opt-in.

### 5. Voice and response workflows — expanded local workflow

- When verified first-party voice artifacts are installed, the user can upload or explicitly record audio (maximum 30 seconds/2 MiB), review the audio, and separately request local transcription. The resulting transcript is displayed for review and enters the Chat draft only after a distinct action.
- The user can separately request local speech synthesis for an assistant reply, listen to the generated audio, and explicitly stop microphone capture. Recording, transcription, draft insertion, and synthesis never begin automatically.
- Audio operations use the local Core voice service; no provider-native voice transfer is claimed. When voice artifacts are absent, recording/transcription/synthesis controls remain disabled.

### 6. Cross-provider qualification — ongoing

- Contract tests must use synthetic fixtures and be labeled as such. Live calls remain opt-in and are not a CI requirement.
- Capability claims require a cited adapter/API contract or a user-requested successful test. Keep documented model IDs exactly as the provider reports them.
- Update the per-provider matrix only when evidence changes; preserve the distinction between compatible endpoint, listed model, tested connection, and successful inference.

## Guardrails for every phase

- The local Docker app is not the same thing as local inference. A selected cloud provider receives a request only when the user sends it or explicitly invokes that provider's tool.
- No shared credentials, key-pasting into chat, paid account setup, automatic provider test, automatic inference, automatic search, silent fallback, or fabricated pricing/capabilities.
- Treat local chat history and browser metadata as private user data. Do not expose the unauthenticated server beyond its loopback-by-default binding without an explicitly authorized security design.
- Preserve the five areas, no-account product choice, local-by-default data, and the user's no-cost requirement. Features involving a vendor API must disclose that vendor charges may apply and remain optional.

# Provider landscape and cost boundary

Ragam's built-in catalogue currently contains **46 entries**: 23 `ready`, 22 `gateway_only`, and 1 `pending`. `ready` means the adapter is implemented for its documented API; it does not mean the vendor has been contacted, the user has access, or an account is free. The 22 `gateway_only` Chat APIs are individually adapted and contract-tested with fixtures. Model lists depend on the configured account and are fetched only after the operator explicitly tests a connection.

The **Recommended** label in Provider Settings marks a curated set of 45 entries: 40 major hosted model providers and API platforms across Chat, Image, and Video, plus five selected self-hosted runtimes intended for Local-only use. The hosted list includes notable regional labs and platform specialists alongside global providers. It is a navigation aid, not a live verification, quality/reliability ranking, capability guarantee, or price endorsement. All 46 catalogue entries remain available according to their existing adapter status.

### Recommended shortlist

- **Direct model and cloud APIs:** OpenAI, Anthropic Claude, Google Gemini, Azure OpenAI, Google Vertex AI, Amazon Bedrock, Cohere, Mistral AI, xAI, DeepSeek, Baidu Qianfan, Alibaba Cloud Model Studio, MiniMax, Moonshot AI (Kimi), and Sarvam AI.
- **Chat API platforms and routers:** OpenRouter, Hugging Face Inference Providers, Together AI, Fireworks AI, Groq, Cerebras, DeepInfra, Perplexity Router, SiliconFlow, Novita AI, and SambaNova.
- **Image and Video APIs:** OpenAI Images, Google Gemini Images, Stability AI, Recraft, Ideogram, Black Forest Labs (FLUX), Adobe Firefly, fal.ai, Replicate, Google Veo, Runway, Luma AI, fal.ai Video, and Replicate Video.
- **Self-hosted runtimes for Local-only use:** Ollama, llama.cpp, vLLM, LocalAI, and ComfyUI. Diffusers remains pending and is not selectable.

## Provider entries

### Direct Chat and cloud-runtime adapters (`ready`)

Anthropic Claude, Google Gemini, Cohere, Azure OpenAI, Google Vertex AI, and Amazon Bedrock.

### Separately supported image and video adapters (`ready`)

- **Image:** OpenAI Images, Google Gemini Images, Stability AI, Recraft, Ideogram, Black Forest Labs (FLUX), fal.ai, Replicate, Adobe Firefly, and ComfyUI (self-hosted).
- **Video:** Google Veo, Runway, Luma AI, fal.ai Video, and Replicate Video.

### Chat APIs routed through the tested gateway (`gateway_only`)

OpenAI, Baidu Qianfan, Alibaba Cloud Model Studio, OpenRouter, Mistral AI, DeepSeek, Cerebras, DeepInfra, MiniMax, SiliconFlow, Moonshot AI (Kimi), Sarvam AI, Groq, Together AI, Fireworks AI, xAI, Perplexity Router, Novita AI, SambaNova, Hugging Face Inference Providers, vLLM (self-hosted), and LocalAI (self-hosted).

### Local runtimes

Ollama and llama.cpp server are listed as ready OpenAI-compatible connections. vLLM and LocalAI have individually adapted OpenAI-compatible APIs and can also be configured at a private/local endpoint. For Local-only use, the Recommended badge marks Ollama, llama.cpp, vLLM, LocalAI, and ComfyUI; the endpoint and any model license must still be checked by the operator. ComfyUI is the local image-generation adapter.

### Pending

Diffusers is catalogued as pending and is not offered as a working connection.

## Free-use limitation

Ragam does not charge for the open-source application, but it cannot make a remote provider's API free. Vendor pricing, free credits, rate limits and eligibility change and may depend on model, region, account and date. This catalogue deliberately makes **no free-tier guarantee**. Confirm the provider's current terms before sending a billable request.

The browser's **Local-only** mode defaults on and blocks Chat, Image and Video inference from remote providers. The catalog and saved provider settings remain available for configuration, but they cannot serve inference requests until the user explicitly turns Local-only off. The Core independently checks the selected runtime and endpoint; a provider ID alone is not proof of locality. It permits first-party Klyvaron, plus the known self-hosted Chat runtimes (Ollama, llama.cpp, vLLM and LocalAI) only at private/local addresses, and ComfyUI for image generation only at private/local addresses. The outbound gateway also restricts Local-only connections to private resolved IP addresses. Generic/custom gateways are not allowlisted because they may route onward to remote vendors. No local Video runtime other than verified Klyvaron is supported. Hosted BYOK has no local inference runtime and refuses Local-only requests on the server.

To use a remote provider, explicitly turn Local-only off and approve the request where prompted; provider charges and retention policies may apply. Provider Settings' manual model refresh/connection test is a separate configuration action and may contact that provider; Local-only protects inference, not operator-initiated discovery. Self-hosted Klyvaron and local runtimes can avoid a third-party inference invoice when their verified model artifacts and hardware are already available; hardware, electricity, storage and model-license obligations remain.

The catalogue is not an exhaustive inventory of every provider worldwide. New adapters require a public, documented API, a provider-specific wire implementation, mocked contract tests, safe endpoint/credential handling, and an explicit capability statement. No API keys are committed or requested by this document; tests use local fixtures and make no vendor calls.

# Provider landscape and cost boundary

Ragam's built-in catalogue currently contains **47 entries**: 24 `ready`, 22 `gateway_only`, and 1 `pending`. `ready` means the adapter is implemented for its documented API; it does not mean the vendor has been contacted, the user has access, or an account is free. The 22 `gateway_only` Chat APIs are individually adapted and contract-tested with fixtures. Model lists depend on the configured account and are fetched only after the operator explicitly tests a connection.

## Provider entries

### Direct Chat and cloud-runtime adapters (`ready`)

Anthropic Claude, Google Gemini, Cohere, Azure OpenAI, Google Vertex AI, and Amazon Bedrock.

### Separately supported image and video adapters (`ready`)

- **Image:** OpenAI Images, Google Gemini Images, Stability AI, Recraft, Ideogram, Black Forest Labs (FLUX), fal.ai, Replicate, Adobe Firefly, and ComfyUI (self-hosted).
- **Video:** Google Veo, Runway, Luma AI, fal.ai Video, and Replicate Video.

### Chat APIs routed through the tested gateway (`gateway_only`)

OpenAI, Baidu Qianfan, Alibaba Cloud Model Studio, OpenRouter, Mistral AI, DeepSeek, Cerebras, DeepInfra, MiniMax, SiliconFlow, Moonshot AI (Kimi), Sarvam AI, Groq, Together AI, Fireworks AI, xAI, Perplexity Router, Novita AI, SambaNova, Hugging Face Inference Providers, vLLM (self-hosted), and LocalAI (self-hosted).

### Local runtimes (`ready`)

LiteLLM gateway, Ollama, and llama.cpp server are listed as ready OpenAI-compatible connections. They can point to self-hosted models, but the endpoint and any model license must be checked by the operator. ComfyUI is the local image-generation adapter.

### Pending

Diffusers is catalogued as pending and is not offered as a working connection.

## Free-use limitation

Ragam does not charge for the open-source application, but it cannot make a remote provider's API free. Vendor pricing, free credits, rate limits and eligibility change and may depend on model, region, account and date. This catalogue deliberately makes **no free-tier guarantee**. Confirm the provider's current terms before sending a billable request. Self-hosted Klyvaron and local runtimes can avoid a third-party inference invoice when their verified model artifacts and hardware are already available; hardware, electricity, storage and model-license obligations remain. Hosted BYOK always sends to the selected remote provider after the user's per-request approval and may incur that provider's charges.

The catalogue is not an exhaustive inventory of every provider worldwide. New adapters require a public, documented API, a provider-specific wire implementation, mocked contract tests, safe endpoint/credential handling, and an explicit capability statement. No API keys are committed or requested by this document; tests use local fixtures and make no vendor calls.

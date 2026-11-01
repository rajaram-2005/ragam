# User-managed MCP and plugin servers

This guide describes the browser workflows in the five existing Ragam areas. Connections and credentials are stored on that user's self-hosted Docker installation; no shared Ragam server or paid service is involved. Only the installation owner can add or remove connections.

## MCP: Streamable HTTP

1. Open **MCP → Connect an MCP Streamable HTTP server**.
2. Enter a unique server ID, a display name, the server's Streamable HTTP endpoint, and an optional bearer token.
3. Confirm that you trust the endpoint. Public hosts must use HTTPS. A private/local endpoint is allowed only after this explicit trust choice; trust is for that exact origin.
4. Ragam negotiates MCP protocol version `2025-03-26`, sends `notifications/initialized`, and reads `tools/list` (including paginated tool lists). It registers the discovered tools as remote transport tools; Ragam does not install server code.
5. Before a remote tool call, enter its arguments and check **I approve sending these arguments**. Every remote MCP tool has risk `external`, even if its declared operation looks read-only. The checked arguments go to the configured endpoint; the reply is untrusted data and cannot authorize another action.

The HTTP transport has a total request deadline, response-size limit, DNS/private-address checks, no redirect following, cancellation, and exact-origin trust for private/local endpoints. Bearer tokens are encrypted in the local provider-secret store and never returned by the API. Disconnecting removes the saved endpoint and credential.

The current connector discovers and invokes tools. It does not currently mirror remote MCP resources or prompts into the UI.

## Plugins: Ragam HTTP plugin protocol

Plugins do not execute downloaded code. A user-managed plugin is a validated manifest whose capabilities are delegated to the endpoint in that manifest. Ragam currently implements the protocol identifier `ragam-plugin/1`.

In **Plugins → Connect a Ragam HTTP plugin server**, provide a JSON manifest and optional bearer token. Every manifest must:

- use `protocol: "http_api"` and provide an absolute endpoint URL;
- declare exactly `scopes: ["service.external"]`;
- give every capability a JSON Schema `inputSchema` and declare `requiredScopes: ["service.external"]`;
- use a unique ID and a valid semantic version.

Only `service.external` is grantable to user-managed HTTP plugins. Filesystem, terminal, credentials, device and other scopes are rejected. After a successful handshake the plugin is installed disabled; the owner enables it in the Plugins list. Each capability call then requires a fresh explicit consent to send its arguments to the remote endpoint. The declared output schema is checked, and returned data is marked untrusted.

### Wire contract

Ragam sends one JSON `POST` to the manifest's endpoint. A bearer token, if configured, is sent as `Authorization: Bearer …`.

Handshake request:

```json
{
  "protocol": "ragam-plugin/1",
  "operation": "handshake",
  "pluginId": "example-plugin",
  "pluginVersion": "1.0.0"
}
```

Handshake response:

```json
{ "protocol": "ragam-plugin/1", "ok": true }
```

Invocation request:

```json
{
  "protocol": "ragam-plugin/1",
  "operation": "invoke",
  "pluginId": "example-plugin",
  "pluginVersion": "1.0.0",
  "capability": "lookup.record",
  "invocationId": "<unique request id>",
  "input": { "query": "example" }
}
```

Successful response:

```json
{ "protocol": "ragam-plugin/1", "ok": true, "output": { "result": "example" } }
```

The `output` must satisfy the manifest's `outputSchema` when one is declared. An error response or a response with the wrong protocol identifier is rejected. Raw vendor response bodies are not shown to the browser.

The same URL safety policy as MCP applies: public endpoints require HTTPS; an owner may explicitly trust an exact private/local origin. Requests are bounded and redirects are not followed. The endpoint and manifest are stored locally; the bearer token is encrypted at rest.

## Existing model endpoints versus model-weight training

These are separate workflows in **Chat**, not a sixth navigation area:

- **Provider Settings** registers an existing inference endpoint. Ragam lists models the configured endpoint reports; selecting a model does not download, train, or rebrand its weights. Requests use the exact selected model and do not silently fall back.
- **Create or adapt model weights** is a separate user-opt-in workflow in Chat. The user pairs their own computer, supplies explicitly authorized training examples, reviews the data/resource/license disclosure, and confirms before a job. Interactive lightweight adaptation has an absolute 120-second deadline measured from the Execute action and covering setup through finalization; the worker is stopped at the deadline. Base-model pretraining is a separately named mode, not a 120-second interactive adaptation. Compatible base-weight digests, licenses, resource limits, validation, and rollback gates still apply. A training result is not marked operational or first-party merely because a job was requested or completed.

A connected server does not gain access to other accounts' conversation, memory or knowledge stores. Remote tool arguments are only sent as a consequence of the visible per-call approval.

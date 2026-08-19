# opencode-openai-http-server

An OpenCode plugin that exposes a stateless OpenAI-compatible Chat Completions server using the providers and credentials already configured in OpenCode.

The plugin starts a second HTTP listener when OpenCode starts through `opencode serve`, the TUI, or the desktop application. OpenCode's own server remains unchanged.

## How It Works

For each completion, the plugin creates a disposable OpenCode session and captures the authenticated provider request that OpenCode's AI SDK prepares. The capture request receives a synthetic response and is never sent to the model endpoint. The plugin then replaces the synthetic prompt with the caller's complete messages, images, and tools and makes one real provider request.

This avoids the previous prompt-mediated tool dispatcher and prevents OpenCode system instructions, AGENTS instructions, built-in tools, MCP tools, and session history from reaching the real inference request.

The burner session:

- Contains only a fixed capture sentinel.
- Uses `{ "*": false }`, disabling every OpenCode tool.
- Has its OpenCode system prompt removed by a request-scoped plugin hook.
- Is always deleted after capture, failure, timeout, cancellation, or shutdown.

The HTTP API retains no session or conversation state. Clients must send the complete conversation on every request.

## Installation

Configure the npm plugin using OpenCode's tuple form:

```json
{
  "plugin": [
    [
      "opencode-openai-http-server",
      {
        "host": "127.0.0.1",
        "port": 4097,
        "cors": false,
        "token": "replace-with-a-secret"
      }
    ]
  ]
}
```

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `host` | `127.0.0.1` | Listener address. A token is required outside loopback. |
| `port` | `4097` | Listener port. `0` selects an ephemeral port for tests. |
| `cors` | `false` | `true` allows all origins; a string array is an exact allowlist. |
| `token` | unset | Optional bearer token expected in `Authorization`. |

Configuration is read from the plugin tuple only. The plugin does not use `OPENAI_API_KEY` as an upstream key; provider authentication comes from OpenCode.

## Endpoints

- `POST /v1/chat/completions`
- `GET /v1/models`
- `GET /v1/version`

All configured routes require the bearer token when `token` is set.

### Models

Model IDs use `provider/model`, preserving additional slashes in the model portion.

```bash
curl http://127.0.0.1:4097/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

The model list uses the active OpenCode project configuration. It applies enabled/disabled providers and provider model allowlists/blocklists, and lists only known OpenAI Chat or OpenAI Responses transports. A custom provider whose actual captured request uses another protocol is rejected before any real inference request is sent.

### Versions

```bash
curl http://127.0.0.1:4097/v1/version \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

The result contains the plugin package version and running OpenCode version:

```json
{
  "object": "version",
  "plugin": "0.0.1",
  "opencode": "1.18.15"
}
```

## Chat Completions

### Text

```bash
curl http://127.0.0.1:4097/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "messages": [{"role": "user", "content": "Reply briefly."}]
  }'
```

### Streaming

```bash
curl -N http://127.0.0.1:4097/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "stream": true,
    "messages": [{"role": "user", "content": "Write one sentence."}]
  }'
```

Streaming responses use OpenAI Chat Completion SSE chunks and end with `data: [DONE]`. Provider text and explicit reasoning are streamed as they arrive. Tool calls are returned with stable indices after their complete provider output is collected.

Explicit provider reasoning is exposed through the nonstandard `reasoning_content` field in JSON messages and streaming deltas. Hidden chain-of-thought is never inferred or exposed.

### Images

User message content accepts OpenAI `image_url` parts with an HTTP(S) URL or base64 image data URL:

```json
{
  "model": "openai/gpt-4o",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe this image."},
        {
          "type": "image_url",
          "image_url": {"url": "data:image/png;base64,iVBORw0KGgo..."}
        }
      ]
    }
  ]
}
```

Data URLs are validated and size-bounded before a burner session is created. Remote URLs are passed through and are not downloaded by the plugin. OpenAI file IDs are not supported.

### Function Tools

Client-provided tools are sent to the provider as native OpenAI function tools. They are never registered with or executed by OpenCode.

```bash
curl http://127.0.0.1:4097/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "messages": [
      {"role": "user", "content": "What is the current stock price of AAPL?"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_stock_price",
          "description": "Retrieves a stock price for a ticker symbol.",
          "parameters": {
            "type": "object",
            "properties": {"ticker": {"type": "string"}},
            "required": ["ticker"]
          }
        }
      }
    ]
  }'
```

The response returns every parallel provider call in `choices[0].message.tool_calls` with `finish_reason: "tool_calls"`. Arguments are returned exactly as generated, matching OpenAI behavior; the plugin does not validate or execute them.

After executing the calls, send a new request containing the complete history:

```json
{
  "model": "openai/gpt-4o",
  "messages": [
    {"role": "user", "content": "What is the current stock price of AAPL?"},
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_abc",
          "type": "function",
          "function": {
            "name": "get_stock_price",
            "arguments": "{\"ticker\":\"AAPL\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_abc",
      "content": "{\"price\":226.12}"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_stock_price",
        "parameters": {
          "type": "object",
          "properties": {"ticker": {"type": "string"}},
          "required": ["ticker"]
        }
      }
    }
  ]
}
```

This continuation creates a new burner session. Correlation comes entirely from the resent call IDs and messages.

## Compatibility

Supported upstream protocols:

- OpenAI Chat Completions.
- OpenAI Responses, translated internally to the public Chat Completions schema.

Not currently supported:

- Google Gemini/Vertex native protocols.
- Anthropic Messages.
- AWS Bedrock native protocols.
- OpenCode's experimental native LLM runtime or transports that bypass `fetch`.
- Stateful OpenAI Responses API.
- Structured output and `response_format`.
- `tool_choice`.

Unsupported transports return an OpenAI-shaped `unsupported_provider` error before the plugin sends a real inference request. Disable OpenCode's experimental native LLM runtime for models used through this plugin.

Only explicit OpenAI-compatible request fields are mapped. Unrelated sampling and output-format fields are currently ignored rather than blindly forwarded through OpenCode.

## Security

- Use a bearer token whenever the listener is reachable by another user or host.
- A token is mandatory when binding outside loopback.
- Captured authorization headers are kept in memory only and are not logged.
- Capture markers are random, request-scoped, stripped before real upstream requests, and invalidated before burner cleanup.
- Request errors are sanitized and do not include provider bodies, credentials, messages, or image data.

## Development

- `mise run typecheck`
- `mise run lint`
- `mise run test`
- `mise run build`
- `mise run pkgjsonlint`

## License

See [LICENSE](LICENSE).

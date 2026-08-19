# opencode-openai-http-server

An OpenCode plugin that starts a stateless, OpenAI-compatible Chat Completions server alongside OpenCode.

The plugin uses OpenCode's configured providers and models. Every completion runs in a new burner session that is deleted after the response, timeout, failure, or client disconnect. OpenCode's built-in tools are disabled for these requests.

## Installation

Add the package to OpenCode's plugin configuration using the tuple form so server options are passed to the plugin:

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

OpenCode loads the plugin when `opencode serve`, the TUI, or the desktop application starts. The OpenAI-compatible listener starts automatically on its own port.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `host` | `127.0.0.1` | Listener address. A token is required for a non-loopback address. |
| `port` | `4097` | Listener port. Use `0` to select an ephemeral port in tests. |
| `cors` | `false` | `true` allows all origins; an array allows exact origins. |
| `token` | unset | Bearer token required in the OpenAI `Authorization` header. |

Configuration is read only from the OpenCode plugin tuple. Environment-variable overrides are not supported.

## Endpoints

- `POST /v1/chat/completions`
- `GET /v1/models`
- `GET /version`

Model IDs use `provider/model` form, for example `anthropic/claude-sonnet-4`. Query `/v1/models` for the models available in the current OpenCode configuration.

```bash
curl http://127.0.0.1:4097/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

`GET /version` returns both the plugin and running OpenCode versions.

## Chat Completions

### Text

```bash
curl http://127.0.0.1:4097/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4",
    "messages": [{"role": "user", "content": "Reply briefly."}]
  }'
```

The complete `messages` history is reconstructed in a new OpenCode session for every request. The server stores no conversation identifier and never reuses a previous burner session.

### Streaming

Set `stream` to `true`. The response uses OpenAI-style SSE chunks followed by `data: [DONE]`.

```bash
curl -N http://127.0.0.1:4097/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4",
    "stream": true,
    "messages": [{"role": "user", "content": "Write one sentence."}]
  }'
```

Visible OpenCode reasoning parts are returned through the nonstandard `reasoning_content` field in messages and streaming deltas. Hidden provider reasoning is not exposed.

### Images

User content supports OpenAI `image_url` parts containing an HTTP(S) URL or `data:image/...` URL. Remote URLs are passed to OpenCode without being fetched by this plugin.

```json
{
  "model": "openai/gpt-4o",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe this image."},
        {"type": "image_url", "image_url": {"url": "https://example.com/image.png"}}
      ]
    }
  ]
}
```

Base64 data URLs are validated and bounded before an OpenCode session is created. The selected model must support image input.

## Function Tools

Client-provided OpenAI function tools are supported through an isolated bridge tool named `openai_compatable_tool_dispatcher`.

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
            "required": ["ticker"],
            "additionalProperties": false
          }
        }
      }
    ]
  }'
```

The bridge never executes the external function. It returns validated calls in `choices[0].message.tool_calls` with `finish_reason: "tool_calls"`. Parallel calls captured during the bounded collection window are returned together.

The dispatcher validates generated arguments directly against the submitted JSON Schema using Ajv. Invalid arguments are returned to the model for up to three correction attempts; only schema-valid calls are exposed to the client.

After executing the function, send the complete history in a new request:

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
          "id": "call_...",
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
      "tool_call_id": "call_...",
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

## Compatibility

Supported request behavior:

- Stateless Chat Completions with one choice.
- System, developer, user, assistant, and tool messages.
- Text and `image_url` content.
- Streaming text, reasoning, tool calls, finish reasons, and usage when OpenCode reports it.
- Function tools and parallel tool-call responses.

Other Chat Completions fields are accepted but ignored, including sampling controls, `n`, `tool_choice`, `parallel_tool_calls`, and `response_format`. Structured outputs and the stateful Responses API are not implemented.

### Tool bridge limitations

OpenCode does not currently expose request-scoped custom tool definitions or stateless native tool-result injection through its public session API. Therefore:

- Dynamic tool names, schemas, prior calls, and results are represented in a strict prompt protocol.
- The model sees one native dispatcher rather than each external function as a native OpenCode tool.
- Parallel collection uses a short quiet window because the bridge cannot know the intended call count in advance.
- The client must execute tools and resend the complete conversation.
- Native provider-level function-call fidelity cannot be guaranteed without an OpenCode API change.

The dispatcher is registered instance-wide and may appear in OpenCode's internal tool listings. It is denied by default, enabled only for allowlisted burner sessions, and rejects execution for ordinary TUI, desktop, and server sessions. Burner prompts disable every other OpenCode tool.

## Development

- `mise run typecheck` - Type-check source and tests.
- `mise run lint` - Run ESLint and Prettier checks.
- `mise run test` - Run the Bun test suite.
- `mise run build` - Build JavaScript and declarations.
- `mise run pkgjsonlint` - Validate package metadata conventions.

## License

See [LICENSE](LICENSE).

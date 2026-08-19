# OpenAI Local Plugin Testing

This document records how to run an isolated OpenCode server with the local plugin and test the OpenAI OAuth provider without interfering with the normal OpenCode process.

## Why Use An Isolated Server

OpenCode initializes plugins lazily per project directory and caches each project instance for the lifetime of the process. Rebuilding the plugin does not reload it in an existing instance. A failed initialization may also remain cached even after the source is fixed.

The isolated command uses:

- OpenCode port `4198` instead of the normal server port.
- Plugin API port `4098` instead of the configured production port `4097`.
- `OPENCODE_CONFIG_CONTENT` to load the local package with explicit plugin options.
- A request to `/config?directory=...` to force OpenCode to initialize that project and load the plugin.
- A shell trap to stop the temporary OpenCode process after the test.

## Base Command

Run this from the repository root:

```bash
env OPENCODE_CONFIG_CONTENT='{"plugin":[["file:///home/debanjand/Documents/Projects/opencode-openai-http-server",{"host":"127.0.0.1","port":4098,"cors":false}]]}' \
  opencode serve --hostname 127.0.0.1 --port 4198 &

pid=$!
cleanup() {
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
}
trap cleanup EXIT

sleep 3

curl --fail-with-body --silent --show-error \
  'http://127.0.0.1:4198/config?directory=/home/debanjand/Documents/Projects/opencode-openai-http-server' \
  >/dev/null

sleep 3
```

The `/config` request is required. Merely starting `opencode serve` does not guarantee that the project instance or plugin has been initialized.

## Text Test

After the base command has initialized the plugin:

```bash
curl --fail-with-body --silent --show-error --max-time 60 \
  http://127.0.0.1:4098/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "openai/gpt-5.6-luna",
    "messages": [
      {
        "role": "user",
        "content": "Reply with OK only."
      }
    ]
  }'
```

## Function Tool Test

```bash
curl --fail-with-body --silent --show-error --max-time 60 \
  http://127.0.0.1:4098/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "openai/gpt-5.6-luna",
    "messages": [
      {
        "role": "system",
        "content": "Be concise."
      },
      {
        "role": "user",
        "content": "What is the current stock price of AAPL?"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_stock_price",
          "description": "Retrieves a stock price.",
          "parameters": {
            "type": "object",
            "properties": {
              "ticker": {
                "type": "string"
              }
            },
            "required": ["ticker"]
          }
        }
      }
    ]
  }'
```

The expected response has `finish_reason: "tool_calls"` and returns `get_stock_price` without executing it.

## Base64 Image Test

The following command generates a valid 64x64 red PNG with `ffmpeg`, base64-encodes it, constructs the OpenAI request with `jq`, and sends it to the plugin:

```bash
image=$(
  ffmpeg \
    -loglevel error \
    -f lavfi \
    -i color=c=red:s=64x64 \
    -frames:v 1 \
    -f image2pipe \
    -vcodec png \
    - \
  | base64 -w0
)

jq -n --arg image "$image" '{
  model: "openai/gpt-5.6-luna",
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Confirm that you received the image and state its color."
        },
        {
          type: "image_url",
          image_url: {
            url: ("data:image/png;base64," + $image)
          }
        }
      ]
    }
  ]
}' |
  curl --fail-with-body --silent --show-error --max-time 90 \
    http://127.0.0.1:4098/v1/chat/completions \
    -H 'Content-Type: application/json' \
    --data-binary @-
```

Verified result:

```json
{
  "message": {
    "role": "assistant",
    "content": "I received the image. Its color is red."
  },
  "finish_reason": "stop"
}
```

A commonly copied 1x1 PNG base64 sample was rejected by OpenAI with `invalid_value`, even though its bytes were recognizable as PNG locally. Use a generated, known-good image for smoke tests. The plugin validates data URL syntax, canonical base64, MIME type, and decoded size; the provider remains responsible for validating the actual image codec contents and dimensions.

## OpenAI Bugs Found

### Runtime `fetch.preconnect` assumption

The Bun TypeScript definition exposes `fetch.preconnect`, but the fetch implementation inside OpenCode did not provide it at runtime. Plugin initialization failed while evaluating:

```ts
originalFetch.preconnect.bind(originalFetch);
```

Fix: attach a no-op `preconnect` fallback when the runtime method is absent.

### OpenCode project instance caching

OpenCode loads plugins lazily per project directory. Rebuilding the plugin or fixing an initialization error does not reload an already-created project instance. This made the plugin appear broken after restarts when the relevant project instance had not been recreated or a different directory owned the listener.

Testing fix: use a fresh OpenCode process and force initialization with the `/config?directory=...` request.

Architectural follow-up: the plugin should eventually own one process-wide listener instead of attempting to bind the same configured port independently for every OpenCode project instance.

### OAuth OpenAI response content type

The ChatGPT Codex OAuth transport sometimes returned an SSE body without declaring `Content-Type: text/event-stream`. The proxy initially treated every non-SSE content type as JSON and failed with:

```text
Provider returned an unsupported response.
```

Fix: trust an explicit SSE/JSON content type when present, but otherwise read the first body chunk and classify the payload from `event:`, `data:`, comments, or JSON syntax without losing the first streamed bytes.

### Non-streaming JSON response fallback

Some OpenAI-compatible transports may return a complete JSON response even when the request asks for streaming. The proxy initially required SSE for every successful response.

Fix: normalize both complete OpenAI Chat/Responses JSON and their streaming forms into the same internal provider-event sequence.

### Codex rejects Responses `system` roles

The public OpenAI Responses API representation can contain role-bearing message items, but the ChatGPT Codex OAuth endpoint returned an empty HTTP `400` when a Responses input item used role `system`.

The same request succeeded without the system message, and function tools were accepted independently.

Fix for the Responses adapter:

```text
Chat Completions system -> Responses developer
```

Native Chat Completions transports still receive the original `system` role.

### Provider errors lacked diagnostics

The proxy originally discarded every upstream error body and returned only the status. This obscured errors such as invalid image data.

Fix: parse a bounded JSON error body and expose only the provider error code/message. Never include request bodies, authorization headers, or arbitrary non-JSON provider responses.

The Codex endpoint still returns some empty `400` responses, so request-shape isolation may be required when it provides no structured error.

## Model Listing Note

OpenCode does not expose the model selector's client-local show/hide state to plugins. Its public `GET /config/providers` endpoint is the operational model set after applying:

- `enabled_providers` and `disabled_providers`.
- OAuth/provider plugin model filtering.
- Provider `whitelist` and `blacklist`.
- Deprecated and experimental model filtering.

Therefore `/v1/models` uses that operational set and then removes transports unsupported by this proxy. To restrict individual models, configure `provider.<id>.whitelist` in OpenCode rather than relying on UI visibility.

## Finishing The Test

The `trap cleanup EXIT` in the base command stops the temporary OpenCode process automatically when the shell exits. If commands were run manually without the trap:

```bash
kill "$pid"
wait "$pid" 2>/dev/null
```

Normal OpenCode processes and ports are not touched by this isolated workflow.

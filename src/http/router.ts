import type { ResolvedServerOptions } from '../config.ts';
import { MAX_REQUEST_BODY_BYTES } from '../constants.ts';
import { errorBody, errorStatus, ProtocolError } from '../errors.ts';
import { flattenModels } from '../openai/models.ts';
import { parseChatCompletionJSON } from '../openai/parse.ts';
import { toChatCompletion } from '../openai/response.ts';
import {
  contentChunk,
  errorSSE,
  finalChunk,
  initialChunk,
  sseData,
  toolCallChunk,
  usageChunk,
} from '../openai/sse.ts';
import type { NormalizedCompletion } from '../openai/types.ts';
import type { OpenCodeProxyClient } from '../opencode/client.ts';
import type { ProxyRunOptions } from '../proxy/runner.ts';
import { authenticate } from './auth.ts';
import { corsHeaders } from './cors.ts';

export interface RouterDependencies {
  options: ResolvedServerOptions;
  client: Pick<OpenCodeProxyClient, 'providers'>;
  runner: {
    run(
      request: ReturnType<typeof parseChatCompletionJSON>,
      options?: ProxyRunOptions
    ): Promise<NormalizedCompletion>;
  };
  openCodeVersion: string;
  pluginVersion: string;
  isDraining(): boolean;
}

export function createRouter(
  dependencies: RouterDependencies
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const cors = corsHeaders(request, dependencies.options.cors);
    const requestID = crypto.randomUUID();
    cors.set('X-Request-Id', requestID);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      authenticate(request, dependencies.options.token);
      if (dependencies.isDraining()) {
        throw new ProtocolError(503, 'service_unavailable', 'The server is shutting down.');
      }
      const url = new URL(request.url);
      if (url.pathname === '/v1/version' && request.method === 'GET') {
        return json(
          {
            object: 'version',
            plugin: dependencies.pluginVersion,
            opencode: dependencies.openCodeVersion,
          },
          200,
          cors
        );
      }
      if (url.pathname === '/v1/models' && request.method === 'GET') {
        const providers = await dependencies.client.providers();
        return json({ object: 'list', data: flattenModels(providers) }, 200, cors);
      }
      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
        const parsed = parseChatCompletionJSON(await readBoundedBody(request));
        if (parsed.stream) return streamCompletion(request, parsed, dependencies.runner, cors);
        const completion = await dependencies.runner.run(parsed, { signal: request.signal });
        return json(toChatCompletion(completion), 200, cors);
      }
      if (
        url.pathname === '/v1/version' ||
        url.pathname === '/v1/models' ||
        url.pathname === '/v1/chat/completions'
      ) {
        throw new ProtocolError(405, 'invalid_request_error', 'Method not allowed.');
      }
      throw new ProtocolError(404, 'invalid_request_error', 'Route not found.');
    } catch (error) {
      const headers = new Headers(cors);
      if (errorStatus(error) === 401) headers.set('WWW-Authenticate', 'Bearer');
      return json(errorBody(error), errorStatus(error), headers);
    }
  };
}

function streamCompletion(
  request: Request,
  parsed: ReturnType<typeof parseChatCompletionJSON>,
  runner: RouterDependencies['runner'],
  headers: Headers
): Response {
  const encoder = new TextEncoder();
  const streamController = new AbortController();
  let streamCancelled = false;
  const forwardAbort = (): void => streamController.abort(request.signal.reason);
  request.signal.addEventListener('abort', forwardAbort, { once: true });
  const identity = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
  };
  const shell: NormalizedCompletion = {
    ...identity,
    model: parsed.model,
    text: '',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      let closed = false;
      const enqueue = (value: string): void => {
        if (!closed && !streamCancelled && !streamController.signal.aborted)
          controller.enqueue(encoder.encode(value));
      };
      enqueue(sseData(initialChunk(shell)));
      runner
        .run(parsed, {
          signal: streamController.signal,
          identity,
          onEvent(event): void {
            if (event.type !== 'text' && event.type !== 'reasoning') return;
            enqueue(
              sseData(
                contentChunk(
                  shell,
                  event.value,
                  event.type === 'reasoning' ? 'reasoning_content' : 'content'
                )
              )
            );
          },
        })
        .then((completion) => {
          for (const call of completion.toolCalls)
            enqueue(sseData(toolCallChunk(completion, call)));
          enqueue(sseData(finalChunk(completion)));
          const usage = usageChunk(completion);
          if (usage) enqueue(sseData(usage));
          enqueue('data: [DONE]\n\n');
        })
        .catch((error: unknown) => enqueue(errorSSE(error)))
        .finally(() => {
          closed = true;
          request.signal.removeEventListener('abort', forwardAbort);
          if (!streamCancelled) {
            try {
              controller.close();
            } catch {
              // The consumer may have closed the stream concurrently.
            }
          }
        });
    },
    cancel(): void {
      streamCancelled = true;
      streamController.abort('stream_cancelled');
      request.signal.removeEventListener('abort', forwardAbort);
    },
  });
  headers.set('Content-Type', 'text/event-stream');
  headers.set('Cache-Control', 'no-cache');
  headers.set('Connection', 'keep-alive');
  return new Response(body, { status: 200, headers });
}

async function readBoundedBody(request: Request): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw new ProtocolError(413, 'request_too_large', 'Request body exceeds the size limit.');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function json(body: unknown, status: number, headers: Headers): Response {
  const output = new Headers(headers);
  output.set('Content-Type', 'application/json');
  return Response.json(body, { status, headers: output });
}

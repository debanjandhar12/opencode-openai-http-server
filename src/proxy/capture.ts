import { ProtocolError } from '../errors.ts';
import type { CapturedRequest, UpstreamProtocol } from './types.ts';

export const CAPTURE_HEADER = 'x-opencode-openai-capture';

interface PendingCapture {
  resolve(value: CapturedRequest): void;
  reject(error: unknown): void;
  promise: Promise<CapturedRequest>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface SharedCaptureState {
  originalFetch: typeof globalThis.fetch;
  wrapper: typeof globalThis.fetch;
  owners: number;
  pending: Map<string, PendingCapture>;
  closed: Set<string>;
}

const stateKey = Symbol.for('opencode-openai-http-server.capture');

export class CaptureManager {
  private readonly shared: SharedCaptureState;
  private disposed = false;

  constructor() {
    const holder = globalThis as typeof globalThis & { [stateKey]?: SharedCaptureState };
    const existing = holder[stateKey];
    if (existing) {
      existing.owners++;
      this.shared = existing;
      return;
    }

    const originalFetch = globalThis.fetch;
    const shared: SharedCaptureState = {
      originalFetch,
      owners: 1,
      pending: new Map(),
      closed: new Set(),
      wrapper: undefined as unknown as typeof globalThis.fetch,
    };
    shared.wrapper = Object.assign(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1]
      ): Promise<Response> => {
        const request = await materializeRequest(input, init);
        const marker = request.headers.get(CAPTURE_HEADER);
        if (!marker) return originalFetch(input, init);

        const pending = shared.pending.get(marker);
        if (!pending && shared.closed.has(marker)) {
          throw unavailable('Provider request arrived after its capture context closed.');
        }
        if (!pending) return originalFetch(input, init);
        shared.pending.delete(marker);
        closeMarker(shared, marker);
        detachAbort(pending);

        try {
          const captured = await captureRequest(request);
          pending.resolve(captured);
          return syntheticResponse(captured.protocol);
        } catch (error) {
          pending.reject(error);
          throw error;
        }
      },
      {
        preconnect:
          typeof originalFetch.preconnect === 'function'
            ? originalFetch.preconnect.bind(originalFetch)
            : (): void => undefined,
      }
    );
    holder[stateKey] = shared;
    globalThis.fetch = shared.wrapper;
    this.shared = shared;
  }

  get upstreamFetch(): typeof globalThis.fetch {
    return this.shared.originalFetch;
  }

  register(marker: string, signal?: AbortSignal): Promise<CapturedRequest> {
    if (this.disposed) return Promise.reject(unavailable('Capture manager is disposed.'));
    if (this.shared.pending.has(marker)) {
      return Promise.reject(unavailable('Duplicate capture marker.'));
    }
    const deferred = Promise.withResolvers<CapturedRequest>();
    const pending: PendingCapture = { ...deferred, signal };
    if (signal?.aborted) {
      pending.reject(cancelled());
      return pending.promise;
    }
    if (signal) {
      pending.onAbort = (): void => {
        if (!this.shared.pending.delete(marker)) return;
        this.closeMarker(marker);
        pending.reject(cancelled());
      };
      signal.addEventListener('abort', pending.onAbort, { once: true });
    }
    this.shared.pending.set(marker, pending);
    return pending.promise;
  }

  unregister(marker: string, error: unknown = cancelled()): void {
    const pending = this.shared.pending.get(marker);
    this.closeMarker(marker);
    if (!pending) return;
    this.shared.pending.delete(marker);
    detachAbort(pending);
    pending.reject(error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.shared.owners--;
    if (this.shared.owners > 0) return;

    for (const pending of this.shared.pending.values()) {
      detachAbort(pending);
      pending.reject(unavailable('The plugin is shutting down.'));
    }
    this.shared.pending.clear();
    this.shared.closed.clear();
    if (globalThis.fetch === this.shared.wrapper) globalThis.fetch = this.shared.originalFetch;
    const holder = globalThis as typeof globalThis & { [stateKey]?: SharedCaptureState };
    delete holder[stateKey];
  }

  private closeMarker(marker: string): void {
    closeMarker(this.shared, marker);
  }
}

function closeMarker(shared: SharedCaptureState, marker: string): void {
  shared.closed.add(marker);
  const timer = globalThis.setTimeout(() => shared.closed.delete(marker), 2 * 60_000);
  timer.unref?.();
}

async function materializeRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1]
): Promise<Request> {
  if (input instanceof Request) {
    const clone = input.clone();
    return init ? new Request(clone, init) : clone;
  }
  return new Request(input, init);
}

async function captureRequest(request: Request): Promise<CapturedRequest> {
  if (request.method !== 'POST') throw unavailable('Provider request is not a POST request.');
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    throw unavailable('Provider request body is not JSON.');
  }
  if (!isRecord(body)) throw unavailable('Provider request body is invalid.');
  const protocol = detectProtocol(request.url, body);
  const headers = new Headers(request.headers);
  headers.delete(CAPTURE_HEADER);
  headers.delete('content-length');
  headers.delete('connection');
  headers.delete('host');
  return { url: request.url, method: request.method, headers, body, protocol };
}

function detectProtocol(url: string, body: Record<string, unknown>): UpstreamProtocol {
  if (Array.isArray(body.messages) || url.includes('/chat/completions')) return 'chat';
  if (Array.isArray(body.input) || url.includes('/responses')) return 'responses';
  throw unavailable('Provider does not use a supported OpenAI wire protocol.');
}

function syntheticResponse(protocol: UpstreamProtocol): Response {
  const headers = { 'content-type': 'text/event-stream' };
  if (protocol === 'chat') {
    const chunks = [
      {
        id: 'chatcmpl-capture',
        object: 'chat.completion.chunk',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'captured' }, finish_reason: null },
        ],
      },
      {
        id: 'chatcmpl-capture',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ];
    return new Response(
      `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
      { headers }
    );
  }

  const response = {
    id: 'resp_capture',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: 'capture',
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress' } },
    { type: 'response.completed', response },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers }
  );
}

function detachAbort(pending: PendingCapture): void {
  if (pending.signal && pending.onAbort)
    pending.signal.removeEventListener('abort', pending.onAbort);
}

function unavailable(message: string): ProtocolError {
  return new ProtocolError(502, 'unsupported_provider', message);
}

function cancelled(): ProtocolError {
  return new ProtocolError(499, 'upstream_error', 'The request was cancelled.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { REQUEST_TIMEOUT_MS } from '../constants.ts';
import { ProtocolError } from '../errors.ts';
import { assertModelCapabilities, resolveModel } from '../openai/models.ts';
import type {
  CapturedToolCall,
  NormalizedCompletion,
  NormalizedUsage,
  ParsedChatCompletionRequest,
} from '../openai/types.ts';
import type { OpenCodeProxyClient } from '../opencode/client.ts';
import { CaptureManager } from './capture.ts';
import { OpenAIWireAdapter } from './openai.ts';
import type { ProviderEvent } from './types.ts';

const CLEANUP_TIMEOUT_MS = 5_000;

export interface ProxyRunOptions {
  signal?: AbortSignal;
  identity?: { id: string; created: number };
  onEvent?(event: ProviderEvent): void;
}

export class ProxyRunner {
  private readonly sessions = new Map<string, string>();
  private readonly active = new Map<AbortController, Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly client: OpenCodeProxyClient,
    private readonly capture: CaptureManager
  ) {}

  markerFor(sessionID: string): string | undefined {
    return this.sessions.get(sessionID);
  }

  isCaptureSession(sessionID: string | undefined): boolean {
    return sessionID !== undefined && this.sessions.has(sessionID);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const controller of this.active.keys()) controller.abort('shutdown');
    await bounded(Promise.allSettled(this.active.values()));
  }

  async run(
    request: ParsedChatCompletionRequest,
    options: ProxyRunOptions = {}
  ): Promise<NormalizedCompletion> {
    if (this.shuttingDown)
      throw new ProtocolError(503, 'service_unavailable', 'The server is shutting down.');
    const controller = new AbortController();
    const finished = Promise.withResolvers<void>();
    this.active.set(controller, finished.promise);
    const timeout = globalThis.setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
    const forwardAbort = (): void => controller.abort(options.signal?.reason ?? 'cancelled');
    options.signal?.addEventListener('abort', forwardAbort, { once: true });

    try {
      const providers = await this.client.providers();
      const model = resolveModel(request.model, providers);
      assertModelCapabilities(model, {
        images: request.messages.some((message) =>
          message.content?.some((part) => part.type === 'image_url')
        ),
        tools: request.tools.length > 0,
      });
      const captured = await this.captureProviderRequest(
        model.providerID,
        model.modelID,
        controller.signal
      );
      const adapter = new OpenAIWireAdapter(captured.protocol);
      const upstream = adapter.buildRequest(captured, request, controller.signal);
      const response = await this.capture.upstreamFetch(upstream.url, upstream.init);
      const completion = emptyCompletion(request.model, options.identity);
      const calls = new Map<number, CapturedToolCall>();
      for await (const event of adapter.events(response, controller.signal)) {
        applyEvent(completion, calls, event);
        options.onEvent?.(event);
      }
      completion.toolCalls = [...calls.values()].sort((left, right) => left.index - right.index);
      if (completion.toolCalls.length > 0) completion.finishReason = 'tool_calls';
      return completion;
    } catch (error) {
      if (controller.signal.aborted) throw cancellationError(controller.signal.reason);
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(502, 'upstream_error', 'The provider request failed.');
    } finally {
      globalThis.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', forwardAbort);
      this.active.delete(controller);
      finished.resolve();
    }
  }

  private async captureProviderRequest(providerID: string, modelID: string, signal: AbortSignal) {
    let sessionID: string | undefined;
    let marker: string | undefined;
    let promptRunning = false;
    try {
      sessionID = await this.client.createSession();
      if (signal.aborted) throw cancellationError(signal.reason);
      marker = crypto.randomUUID();
      this.sessions.set(sessionID, marker);
      const captured = this.capture.register(marker, signal);
      promptRunning = true;
      const prompt = this.client.promptCapture(sessionID, providerID, modelID);
      prompt.catch(() => undefined);
      const result = await Promise.race([
        captured,
        prompt.then(() => {
          throw new ProtocolError(
            502,
            'unsupported_provider',
            'OpenCode completed without exposing a supported provider request.'
          );
        }),
        abortPromise(signal),
      ]);
      await Promise.race([prompt, abortPromise(signal)]);
      promptRunning = false;
      return result;
    } finally {
      if (marker) this.capture.unregister(marker);
      if (sessionID) {
        this.sessions.delete(sessionID);
        const cleanup: Promise<unknown>[] = [];
        if (promptRunning) cleanup.push(bounded(this.client.abortSession(sessionID)));
        cleanup.push(bounded(this.client.deleteSession(sessionID)));
        await Promise.allSettled(cleanup);
      }
    }
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(cancellationError(signal.reason));
    else
      signal.addEventListener('abort', () => reject(cancellationError(signal.reason)), {
        once: true,
      });
  });
}

function emptyCompletion(
  model: string,
  identity?: { id: string; created: number }
): NormalizedCompletion {
  return {
    id: identity?.id ?? `chatcmpl-${crypto.randomUUID()}`,
    created: identity?.created ?? Math.floor(Date.now() / 1000),
    model,
    text: '',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
  };
}

function applyEvent(
  completion: NormalizedCompletion,
  calls: Map<number, CapturedToolCall>,
  event: ProviderEvent
): void {
  if (event.type === 'text') completion.text += event.value;
  if (event.type === 'reasoning') completion.reasoning += event.value;
  if (event.type === 'finish') completion.finishReason = event.reason;
  if (event.type === 'usage') {
    const usage: NormalizedUsage = {
      inputTokens: event.input,
      outputTokens: event.output,
      ...(event.reasoning === undefined ? {} : { reasoningTokens: event.reasoning }),
    };
    completion.usage = usage;
  }
  if (event.type === 'tool-start') {
    const existing = calls.get(event.index);
    calls.set(event.index, {
      id: event.id || existing?.id || `call_${crypto.randomUUID()}`,
      name: event.name || existing?.name || '',
      arguments: existing?.arguments ?? '',
      index: event.index,
    });
  }
  if (event.type === 'tool-arguments') {
    const existing = calls.get(event.index) ?? {
      id: `call_${crypto.randomUUID()}`,
      name: '',
      arguments: '',
      index: event.index,
    };
    existing.arguments += event.value;
    calls.set(event.index, existing);
  }
}

async function bounded<T>(promise: Promise<T>): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => globalThis.setTimeout(resolve, CLEANUP_TIMEOUT_MS)),
  ]);
}

function cancellationError(reason: unknown): ProtocolError {
  const timeout = reason === 'timeout';
  return new ProtocolError(
    timeout ? 504 : 499,
    timeout ? 'request_timeout' : 'upstream_error',
    timeout ? 'The provider request timed out.' : 'The request was cancelled.'
  );
}

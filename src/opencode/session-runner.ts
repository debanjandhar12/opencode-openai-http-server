import { REQUEST_TIMEOUT_MS } from '../constants.ts';
import { ProtocolError } from '../errors.ts';
import { assertModelCapabilities, resolveModel } from '../openai/models.ts';
import type {
  NormalizedCompletion,
  NormalizedUsage,
  ParsedChatCompletionRequest,
} from '../openai/types.ts';
import { buildStatelessPrompt } from '../transcript.ts';
import { ToolCallCollector, type ToolCallCollectionResult } from '../tools/collector.ts';
import { DispatcherRegistry } from '../tools/registry.ts';
import type { OpenCodeSessionClient, PromptResult } from './client.ts';
import { EventHub, type AccumulatedCompletion, type CompletionDelta } from './event-hub.ts';

const CLEANUP_TIMEOUT_MS = 5_000;

export interface SessionRunOptions {
  signal?: AbortSignal;
  onDelta?(delta: CompletionDelta): void;
  identity?: { id: string; created: number };
}

export class SessionRunner {
  private readonly active = new Map<AbortController, Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly client: OpenCodeSessionClient,
    private readonly events: EventHub,
    private readonly dispatcher: DispatcherRegistry
  ) {}

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const controller of this.active.keys()) controller.abort('shutdown');
    await bounded(Promise.allSettled([...this.active.values()]), CLEANUP_TIMEOUT_MS);
  }

  async run(
    request: ParsedChatCompletionRequest,
    options: SessionRunOptions = {}
  ): Promise<NormalizedCompletion> {
    if (this.shuttingDown) {
      throw new ProtocolError(503, 'service_unavailable', 'The server is shutting down.');
    }
    const controller = new AbortController();
    const finished = Promise.withResolvers<void>();
    this.active.set(controller, finished.promise);
    const timeout = globalThis.setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
    const forwardAbort = (): void => controller.abort(options.signal?.reason ?? 'cancelled');
    options.signal?.addEventListener('abort', forwardAbort, { once: true });

    let sessionID: string | undefined;
    let promptMayBeRunning = false;
    let emittedText = '';
    let emittedReasoning = '';
    try {
      if (options.signal?.aborted) throw cancelledError(options.signal.reason);
      const providers = await this.client.providers();
      const model = resolveModel(request.model, providers);
      const hasImages = request.messages.some((message) =>
        message.content?.some((part) => part.type === 'image_url')
      );
      assertModelCapabilities(model, { images: hasImages, tools: request.tools.length > 0 });
      const preparedTools = this.dispatcher.prepare(request.tools);
      const prompt = buildStatelessPrompt(request);
      const collector = new ToolCallCollector();

      sessionID = await this.client.createSession();
      if (controller.signal.aborted) throw cancelledError(controller.signal.reason);
      const currentSessionID = sessionID;
      const eventError = Promise.withResolvers<never>();
      this.events.register(currentSessionID, {
        onDelta(delta): void {
          if (delta.type === 'text') emittedText += delta.value;
          else emittedReasoning += delta.value;
          options.onDelta?.(delta);
        },
        onError(error): void {
          eventError.reject(upstreamError(error));
        },
      });
      this.dispatcher.register(currentSessionID, preparedTools, collector, () => {
        this.events.suppressOutput(currentSessionID);
      });

      promptMayBeRunning = true;
      const promptPromise = this.client.prompt(
        currentSessionID,
        model.providerID,
        model.modelID,
        prompt
      );
      promptPromise.catch(() => undefined);
      const outcome = await Promise.race([
        promptPromise.then((result) => ({ type: 'prompt' as const, result })),
        collector.wait().then((result) => ({ type: 'collector' as const, result })),
        eventError.promise,
        abortPromise(controller.signal),
      ]);

      const eventSnapshot = this.events.snapshot(currentSessionID);
      if (outcome.type === 'collector') {
        await bounded(this.client.abortSession(currentSessionID), CLEANUP_TIMEOUT_MS).catch(
          () => undefined
        );
        promptMayBeRunning = false;
        if (outcome.result.type === 'invalid_exhausted') {
          throw new ProtocolError(
            422,
            'tool_arguments_invalid',
            'The model repeatedly produced invalid tool arguments.',
            'tools',
            'unprocessable_entity_error'
          );
        }
        const completion = completionFrom(
          undefined,
          eventSnapshot,
          outcome.result,
          request.model,
          options.identity
        );
        emitMissing(completion, emittedText, emittedReasoning, options.onDelta);
        return completion;
      }

      promptMayBeRunning = false;
      const calls = collector.snapshots();
      collector.close();
      const completion = completionFrom(
        outcome.result,
        this.events.snapshot(currentSessionID),
        calls.length > 0 ? { type: 'closed', calls } : undefined,
        request.model,
        options.identity
      );
      emitMissing(completion, emittedText, emittedReasoning, options.onDelta);
      return completion;
    } catch (error) {
      if (controller.signal.aborted) throw cancelledError(controller.signal.reason);
      if (error instanceof ProtocolError) throw error;
      throw upstreamError(error);
    } finally {
      globalThis.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', forwardAbort);
      if (sessionID) {
        this.events.unregister(sessionID);
        this.dispatcher.unregister(sessionID);
        const cleanup: Promise<unknown>[] = [];
        if (promptMayBeRunning)
          cleanup.push(bounded(this.client.abortSession(sessionID), CLEANUP_TIMEOUT_MS));
        cleanup.push(bounded(this.client.deleteSession(sessionID), CLEANUP_TIMEOUT_MS));
        await Promise.allSettled(cleanup);
      }
      this.active.delete(controller);
      finished.resolve();
    }
  }
}

function completionFrom(
  prompt: PromptResult | undefined,
  events: AccumulatedCompletion,
  collection: ToolCallCollectionResult | undefined,
  model: string,
  identity?: { id: string; created: number }
): NormalizedCompletion {
  let promptText = '';
  let promptReasoning = '';
  for (const part of prompt?.parts ?? []) {
    if (part.type === 'text' && part.synthetic !== true && part.ignored !== true)
      promptText += part.text;
    if (part.type === 'reasoning') promptReasoning += part.text;
  }
  const calls = collection?.calls ?? [];
  const finish = prompt?.info.finish ?? events.finish;
  return {
    id: identity?.id ?? `chatcmpl-${crypto.randomUUID()}`,
    created: identity?.created ?? Math.floor(Date.now() / 1000),
    model,
    text: longest(events.text, promptText),
    reasoning: longest(events.reasoning, promptReasoning),
    toolCalls: calls,
    finishReason: calls.length > 0 ? 'tool_calls' : finish === 'length' ? 'length' : 'stop',
    ...(prompt ? { usage: usageFrom(prompt) } : events.usage ? { usage: events.usage } : {}),
  };
}

function usageFrom(prompt: PromptResult): NormalizedUsage {
  return {
    inputTokens: prompt.info.tokens.input,
    outputTokens: prompt.info.tokens.output,
    ...(prompt.info.tokens.reasoning > 0 ? { reasoningTokens: prompt.info.tokens.reasoning } : {}),
  };
}

function emitMissing(
  completion: NormalizedCompletion,
  emittedText: string,
  emittedReasoning: string,
  emit?: (delta: CompletionDelta) => void
): void {
  if (!emit) return;
  if (completion.reasoning.startsWith(emittedReasoning)) {
    const suffix = completion.reasoning.slice(emittedReasoning.length);
    if (suffix) emit({ type: 'reasoning', value: suffix });
  }
  if (completion.text.startsWith(emittedText)) {
    const suffix = completion.text.slice(emittedText.length);
    if (suffix) emit({ type: 'text', value: suffix });
  }
}

function longest(left: string, right: string): string {
  if (right.startsWith(left)) return right;
  if (left.startsWith(right)) return left;
  return left || right;
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(cancelledError(signal.reason));
    else
      signal.addEventListener('abort', () => reject(cancelledError(signal.reason)), { once: true });
  });
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => globalThis.setTimeout(resolve, timeoutMs)),
  ]);
}

function cancelledError(reason: unknown): ProtocolError {
  const timedOut = reason === 'timeout';
  return new ProtocolError(
    timedOut ? 504 : 499,
    timedOut ? 'request_timeout' : 'upstream_error',
    timedOut ? 'The OpenCode request timed out.' : 'The request was cancelled.'
  );
}

function upstreamError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  return new ProtocolError(502, 'upstream_error', 'The OpenCode request failed.');
}

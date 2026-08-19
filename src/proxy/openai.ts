import { ProtocolError } from '../errors.ts';
import type {
  NormalizedContent,
  NormalizedMessage,
  ParsedChatCompletionRequest,
} from '../openai/types.ts';
import type { CapturedRequest, ProviderAdapter, ProviderEvent } from './types.ts';

export class OpenAIWireAdapter implements ProviderAdapter {
  constructor(private readonly protocol?: CapturedRequest['protocol']) {}

  buildRequest(
    captured: CapturedRequest,
    request: ParsedChatCompletionRequest,
    signal: AbortSignal
  ): { url: string; init: NonNullable<Parameters<typeof globalThis.fetch>[1]> } {
    const body =
      captured.protocol === 'chat'
        ? buildChatBody(captured.body, request)
        : buildResponsesBody(captured.body, request);
    const headers = new Headers(captured.headers);
    headers.set('content-type', 'application/json');
    headers.delete('content-length');
    return {
      url: captured.url,
      init: {
        method: captured.method,
        headers,
        body: JSON.stringify(body),
        signal,
      },
    };
  }

  async *events(response: Response, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    if (!response.ok) throw await upstreamResponseError(response);
    if (!response.body) throw upstreamError('Provider returned an empty response.');
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      throw upstreamError('Provider did not return an event stream.');
    }
    const protocol =
      this.protocol ?? (response.url.includes('/responses') ? 'responses' : undefined);
    const parser = parseSSE(response.body, signal);
    let detected = protocol;
    let finished = false;
    for await (const frame of parser) {
      if (frame.data === '[DONE]') {
        finished = true;
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(frame.data);
      } catch {
        throw upstreamError('Provider returned malformed event data.');
      }
      if (!isRecord(value)) throw upstreamError('Provider returned malformed event data.');
      detected ??=
        typeof value.type === 'string' && value.type.startsWith('response.') ? 'responses' : 'chat';
      const events = detected === 'responses' ? responsesEvents(value) : chatEvents(value);
      for (const event of events) {
        if (event.type === 'finish') finished = true;
        yield event;
      }
    }
    if (!finished) throw upstreamError('Provider stream ended without a completion event.');
  }
}

function buildChatBody(
  template: Record<string, unknown>,
  request: ParsedChatCompletionRequest
): Record<string, unknown> {
  return {
    ...stripDynamic(template),
    messages: request.messages.map(chatMessage),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: tool.function,
          })),
        }),
    stream: true,
    stream_options: { include_usage: true },
  };
}

function chatMessage(message: NormalizedMessage): Record<string, unknown> {
  if (message.role === 'assistant') {
    return {
      role: message.role,
      content: message.content === null ? null : chatContent(message.content),
      ...(message.toolCalls
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    };
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallID,
      content: plainContent(message.content),
    };
  }
  return { role: message.role, content: chatContent(message.content) };
}

function chatContent(content: NormalizedContent[]): string | Record<string, unknown>[] {
  if (content.every((part) => part.type === 'text')) return plainContent(content);
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image_url',
          image_url: {
            url: part.imageUrl.url,
            ...(part.imageUrl.detail ? { detail: part.imageUrl.detail } : {}),
          },
        }
  );
}

function buildResponsesBody(
  template: Record<string, unknown>,
  request: ParsedChatCompletionRequest
): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (message.role === 'assistant' && message.toolCalls) {
      if (message.content?.length) input.push(responsesMessage('assistant', message.content));
      for (const call of message.toolCalls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      continue;
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallID,
        output: plainContent(message.content),
      });
      continue;
    }
    input.push(responsesMessage(message.role, message.content ?? []));
  }
  return {
    ...stripDynamic(template),
    input,
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function',
            name: tool.function.name,
            ...(tool.function.description ? { description: tool.function.description } : {}),
            parameters: tool.function.parameters,
          })),
        }),
    stream: true,
  };
}

function responsesMessage(role: string, content: NormalizedContent[]): Record<string, unknown> {
  return {
    type: 'message',
    role,
    content: content.map((part) =>
      part.type === 'text'
        ? { type: 'input_text', text: part.text }
        : {
            type: 'input_image',
            image_url: part.imageUrl.url,
            detail: part.imageUrl.detail ?? 'auto',
          }
    ),
  };
}

function stripDynamic(template: Record<string, unknown>): Record<string, unknown> {
  const result = { ...template };
  for (const key of [
    'messages',
    'input',
    'instructions',
    'system',
    'user',
    'metadata',
    'tools',
    'tool_choice',
    'stream',
    'stream_options',
    'previous_response_id',
    'prompt_cache_key',
  ]) {
    delete result[key];
  }
  return result;
}

function chatEvents(value: Record<string, unknown>): ProviderEvent[] {
  if (isRecord(value.error)) throw upstreamError('Provider returned an error event.');
  const usage = usageEvent(value.usage);
  const choices = Array.isArray(value.choices) ? value.choices : [];
  if (choices.length > 1) throw upstreamError('Provider returned multiple choices.');
  const choice = choices[0];
  if (!isRecord(choice)) return usage ? [usage] : [];
  const output: ProviderEvent[] = [];
  const delta = isRecord(choice.delta) ? choice.delta : {};
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
    output.push({ type: 'reasoning', value: delta.reasoning_content });
  } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
    output.push({ type: 'reasoning', value: delta.reasoning });
  }
  if (typeof delta.content === 'string' && delta.content)
    output.push({ type: 'text', value: delta.content });
  if (Array.isArray(delta.tool_calls)) {
    for (const rawCall of delta.tool_calls) {
      if (!isRecord(rawCall) || typeof rawCall.index !== 'number') continue;
      const fn = isRecord(rawCall.function) ? rawCall.function : {};
      if (typeof rawCall.id === 'string' || typeof fn.name === 'string') {
        output.push({
          type: 'tool-start',
          index: rawCall.index,
          id: typeof rawCall.id === 'string' ? rawCall.id : `call_${crypto.randomUUID()}`,
          name: typeof fn.name === 'string' ? fn.name : '',
        });
      }
      if (typeof fn.arguments === 'string' && fn.arguments) {
        output.push({ type: 'tool-arguments', index: rawCall.index, value: fn.arguments });
      }
    }
  }
  const finish = finishReason(choice.finish_reason);
  if (finish) output.push({ type: 'finish', reason: finish });
  if (usage) output.push(usage);
  return output;
}

function responsesEvents(value: Record<string, unknown>): ProviderEvent[] {
  const type = value.type;
  if (typeof type !== 'string') return [];
  if (type === 'error' || type === 'response.failed')
    throw upstreamError('Provider returned an error event.');
  if (type === 'response.output_text.delta' && typeof value.delta === 'string') {
    return [{ type: 'text', value: value.delta }];
  }
  if (
    (type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning_text.delta') &&
    typeof value.delta === 'string'
  ) {
    return [{ type: 'reasoning', value: value.delta }];
  }
  if (
    type === 'response.output_item.added' &&
    isRecord(value.item) &&
    value.item.type === 'function_call'
  ) {
    const index = numberValue(value.output_index) ?? 0;
    return [
      {
        type: 'tool-start',
        index,
        id:
          typeof value.item.call_id === 'string'
            ? value.item.call_id
            : typeof value.item.id === 'string'
              ? value.item.id
              : `call_${crypto.randomUUID()}`,
        name: typeof value.item.name === 'string' ? value.item.name : '',
      },
    ];
  }
  if (type === 'response.function_call_arguments.delta' && typeof value.delta === 'string') {
    return [
      { type: 'tool-arguments', index: numberValue(value.output_index) ?? 0, value: value.delta },
    ];
  }
  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = isRecord(value.response) ? value.response : {};
    const output = Array.isArray(response.output) ? response.output : [];
    const hasTools = output.some((item) => isRecord(item) && item.type === 'function_call');
    const events: ProviderEvent[] = [];
    const usage = usageEvent(response.usage);
    if (usage) events.push(usage);
    events.push({
      type: 'finish',
      reason: hasTools ? 'tool_calls' : type === 'response.incomplete' ? 'length' : 'stop',
    });
    return events;
  }
  return [];
}

interface SSEFrame {
  event?: string;
  data: string;
}

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncIterable<SSEFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal.aborted) throw new globalThis.DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: number;
      while ((boundary = eventBoundary(buffer)) >= 0) {
        const raw = buffer.slice(0, boundary).replace(/\r\n/g, '\n');
        buffer = buffer.slice(boundary + (buffer.startsWith('\r\n\r\n', boundary) ? 4 : 2));
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const frame = parseFrame(buffer.replace(/\r\n/g, '\n'));
      if (frame) yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}

function eventBoundary(value: string): number {
  const lf = value.indexOf('\n\n');
  const crlf = value.indexOf('\r\n\r\n');
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function parseFrame(raw: string): SSEFrame | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  return { ...(event ? { event } : {}), data: data.join('\n') };
}

function usageEvent(value: unknown): Extract<ProviderEvent, { type: 'usage' }> | undefined {
  if (!isRecord(value)) return undefined;
  const input = numberValue(value.prompt_tokens) ?? numberValue(value.input_tokens);
  const output = numberValue(value.completion_tokens) ?? numberValue(value.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const details = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : isRecord(value.output_tokens_details)
      ? value.output_tokens_details
      : {};
  const reasoning = numberValue(details.reasoning_tokens);
  return { type: 'usage', input, output, ...(reasoning === undefined ? {} : { reasoning }) };
}

function finishReason(value: unknown): 'stop' | 'length' | 'tool_calls' | undefined {
  if (value === 'tool_calls' || value === 'function_call') return 'tool_calls';
  if (value === 'length' || value === 'max_tokens') return 'length';
  if (value === 'stop') return 'stop';
  return undefined;
}

async function upstreamResponseError(response: Response): Promise<ProtocolError> {
  await response.body?.cancel().catch(() => undefined);
  return upstreamError(`Provider request failed with status ${response.status}.`);
}

function upstreamError(message: string): ProtocolError {
  return new ProtocolError(502, 'upstream_error', message);
}

function plainContent(content: NormalizedContent[]): string {
  return content.map((part) => (part.type === 'text' ? part.text : part.imageUrl.url)).join('');
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

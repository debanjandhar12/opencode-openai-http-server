import type { ParsedChatCompletionRequest } from '../openai/types.ts';

export type UpstreamProtocol = 'chat' | 'responses';

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  protocol: UpstreamProtocol;
}

export type ProviderEvent =
  | { type: 'text'; value: string }
  | { type: 'reasoning'; value: string }
  | { type: 'tool-start'; index: number; id: string; name: string }
  | { type: 'tool-arguments'; index: number; value: string }
  | { type: 'usage'; input: number; output: number; reasoning?: number }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_calls' };

export interface ProviderAdapter {
  buildRequest(
    captured: CapturedRequest,
    request: ParsedChatCompletionRequest,
    signal: AbortSignal
  ): { url: string; init: NonNullable<Parameters<typeof globalThis.fetch>[1]> };
  events(response: Response, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

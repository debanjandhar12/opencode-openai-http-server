import { errorBody } from '../errors.ts';
import { mapUsage } from './response.ts';
import type { CapturedToolCall, NormalizedCompletion } from './types.ts';

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: Record<string, unknown>;
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage?: ReturnType<typeof mapUsage>;
}

export function sseData(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export function initialChunk(completion: NormalizedCompletion): ChatCompletionChunk {
  return chunk(completion, { role: 'assistant' }, null);
}

export function contentChunk(
  completion: NormalizedCompletion,
  delta: string,
  kind: 'content' | 'reasoning_content' = 'content'
): ChatCompletionChunk {
  return chunk(completion, { [kind]: delta }, null);
}

export function toolCallChunk(
  completion: NormalizedCompletion,
  call: CapturedToolCall
): ChatCompletionChunk {
  return chunk(
    completion,
    {
      tool_calls: [
        {
          index: call.index,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        },
      ],
    },
    null
  );
}

export function finalChunk(completion: NormalizedCompletion): ChatCompletionChunk {
  return chunk(
    completion,
    {},
    completion.toolCalls.length > 0 ? 'tool_calls' : completion.finishReason
  );
}

export function usageChunk(completion: NormalizedCompletion): ChatCompletionChunk | undefined {
  if (!completion.usage) return undefined;
  return {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
    choices: [],
    usage: mapUsage(completion.usage),
  };
}

export function completionSSE(completion: NormalizedCompletion): string {
  const frames: string[] = [sseData(initialChunk(completion))];
  if (completion.reasoning)
    frames.push(sseData(contentChunk(completion, completion.reasoning, 'reasoning_content')));
  if (completion.text) frames.push(sseData(contentChunk(completion, completion.text)));
  for (const call of completion.toolCalls) frames.push(sseData(toolCallChunk(completion, call)));
  frames.push(sseData(finalChunk(completion)));
  const usage = usageChunk(completion);
  if (usage) frames.push(sseData(usage));
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

export function errorSSE(error: unknown): string {
  return `${sseData(errorBody(error))}data: [DONE]\n\n`;
}

function chunk(
  completion: NormalizedCompletion,
  delta: Record<string, unknown>,
  finishReason: 'stop' | 'length' | 'tool_calls' | null
): ChatCompletionChunk {
  return {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

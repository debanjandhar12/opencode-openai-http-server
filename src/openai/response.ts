import type { NormalizedCompletion, NormalizedUsage } from './types.ts';

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls';
  }>;
  usage?: OpenAIUsage;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens: number };
}

export function mapUsage(usage: NormalizedUsage): OpenAIUsage {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.reasoningTokens === undefined
      ? {}
      : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
  };
}

export function toChatCompletion(completion: NormalizedCompletion): ChatCompletionResponse {
  const hasToolCalls = completion.toolCalls.length > 0;
  return {
    id: completion.id,
    object: 'chat.completion',
    created: completion.created,
    model: completion.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: completion.text.length === 0 ? null : completion.text,
          ...(completion.reasoning.length === 0 ? {} : { reasoning_content: completion.reasoning }),
          ...(hasToolCalls
            ? {
                tool_calls: completion.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
        finish_reason: hasToolCalls ? 'tool_calls' : completion.finishReason,
      },
    ],
    ...(completion.usage === undefined ? {} : { usage: mapUsage(completion.usage) }),
  };
}

import { describe, expect, it } from 'bun:test';

import { errorBody, ProtocolError } from '../src/errors.ts';
import { toChatCompletion } from '../src/openai/response.ts';
import { completionSSE, errorSSE } from '../src/openai/sse.ts';
import type { NormalizedCompletion } from '../src/openai/types.ts';

const completion: NormalizedCompletion = {
  id: 'chatcmpl-test',
  created: 123,
  model: 'provider/model',
  text: 'working',
  reasoning: 'reason',
  toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"id":1}', index: 0 }],
  finishReason: 'tool_calls',
  usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 1 },
};

describe('OpenAI response mapping', () => {
  it('maps reasoning, validated calls, and usage', () => {
    expect(toChatCompletion(completion)).toMatchObject({
      choices: [
        {
          message: {
            content: 'working',
            reasoning_content: 'reason',
            tool_calls: [{ id: 'call_1', function: { arguments: '{"id":1}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 3,
        total_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    });
  });

  it('emits ordered SSE frames and a final DONE marker', () => {
    const output = completionSSE(completion);
    const role = output.indexOf('"role":"assistant"');
    const reasoning = output.indexOf('"reasoning_content":"reason"');
    const content = output.indexOf('"content":"working"');
    const tool = output.indexOf('"tool_calls"');
    const finish = output.indexOf('"finish_reason":"tool_calls"');
    const usage = output.indexOf('"choices":[]');

    expect(role).toBeLessThan(reasoning);
    expect(reasoning).toBeLessThan(content);
    expect(content).toBeLessThan(tool);
    expect(tool).toBeLessThan(finish);
    expect(finish).toBeLessThan(usage);
    expect(output.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

describe('error sanitization', () => {
  it('preserves typed protocol errors and hides unknown errors', () => {
    expect(errorBody(new ProtocolError(400, 'invalid_schema', 'Bad schema.', 'tools'))).toEqual({
      error: {
        message: 'Bad schema.',
        type: 'invalid_request_error',
        param: 'tools',
        code: 'invalid_schema',
      },
    });
    expect(errorBody(new Error('secret')).error.message).toBe('An internal error occurred.');
    expect(errorSSE(new Error('secret'))).not.toContain('secret');
  });
});

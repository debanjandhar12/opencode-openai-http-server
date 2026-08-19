import { describe, expect, it } from 'bun:test';

import { ProtocolError } from '../src/errors.ts';
import { parseChatCompletionRequest } from '../src/openai/parse.ts';

describe('parseChatCompletionRequest', () => {
  it('normalizes supported fields and ignores unsupported fields', () => {
    const request = parseChatCompletionRequest({
      model: 'provider/model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      temperature: 0.5,
      tool_choice: 'none',
    });

    expect(request).toEqual({
      model: 'provider/model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
      stream: true,
    });
  });

  it('accepts omitted assistant content, preserves opaque arguments, and resolves parallel calls', () => {
    const request = parseChatCompletionRequest({
      model: 'provider/model',
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
        },
      ],
      messages: [
        { role: 'user', content: 'look up two things' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'lookup', arguments: '  {malformed\n' },
            },
            {
              id: 'call_b',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_b', name: 'lookup', content: 'second' },
        { role: 'tool', tool_call_id: 'call_a', name: 'lookup', content: 'first' },
      ],
    });

    expect(request.messages[1]).toMatchObject({
      role: 'assistant',
      content: null,
      toolCalls: [{ arguments: '  {malformed\n' }, { arguments: '{}' }],
    });
  });

  it('accepts null assistant content when tool calls are present', () => {
    const request = parseChatCompletionRequest({
      model: 'provider/model',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: 'result' },
      ],
    });

    expect(request.messages[0]).toMatchObject({ role: 'assistant', content: null });
  });

  it('rejects duplicate call IDs and incomplete tool history', () => {
    expect(() =>
      parseChatCompletionRequest({
        model: 'provider/model',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'same', type: 'function', function: { name: 'a', arguments: '{}' } },
              { id: 'same', type: 'function', function: { name: 'a', arguments: '{}' } },
            ],
          },
        ],
      })
    ).toThrow(ProtocolError);

    expect(() =>
      parseChatCompletionRequest({
        model: 'provider/model',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'pending', type: 'function', function: { name: 'a', arguments: '{}' } },
            ],
          },
          { role: 'user', content: 'continue early' },
        ],
      })
    ).toThrow('All tool calls must have results');

    expect(() =>
      parseChatCompletionRequest({
        model: 'provider/model',
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_a', type: 'function', function: { name: 'a', arguments: '{}' } },
              { id: 'call_b', type: 'function', function: { name: 'b', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_a', content: 'first' },
        ],
      })
    ).toThrow('All tool calls must have results before request end');
  });
});

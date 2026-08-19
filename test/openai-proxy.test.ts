import { describe, expect, it } from 'bun:test';

import { parseChatCompletionRequest } from '../src/openai/parse.ts';
import { OpenAIWireAdapter } from '../src/proxy/openai.ts';
import type { CapturedRequest, ProviderEvent } from '../src/proxy/types.ts';

describe('OpenAI wire adapter', () => {
  it('replaces captured Chat messages and exposes native external tools', () => {
    const adapter = new OpenAIWireAdapter('chat');
    const request = parseChatCompletionRequest({
      model: 'openai/gpt-4o',
      messages: [
        { role: 'system', content: 'Only user system text' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
        },
      ],
    });
    const built = adapter.buildRequest(captured('chat'), request, new AbortController().signal);
    const body = JSON.parse(String(built.init.body));

    expect(body.messages[0]).toEqual({ role: 'system', content: 'Only user system text' });
    expect(body.messages[1].content[1]).toMatchObject({ type: 'image_url' });
    expect(body.tools[0].function.name).toBe('lookup');
    expect(body.stream).toBe(true);
    expect(JSON.stringify(body)).not.toContain('burner sentinel');
  });

  it('maps stateless tool history to Responses input items', () => {
    const adapter = new OpenAIWireAdapter('responses');
    const request = parseChatCompletionRequest({
      model: 'openai/gpt-5',
      messages: [
        { role: 'user', content: 'lookup' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: '{"value":2}' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    });
    const built = adapter.buildRequest(
      captured('responses'),
      request,
      new AbortController().signal
    );
    const body = JSON.parse(String(built.init.body));

    expect(body.input).toEqual([
      expect.objectContaining({ type: 'message', role: 'user' }),
      { type: 'function_call', call_id: 'call_a', name: 'lookup', arguments: '{"x":1}' },
      { type: 'function_call_output', call_id: 'call_a', output: '{"value":2}' },
    ]);
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'lookup' });
  });

  it('parses interleaved Chat tool calls, reasoning, usage, and finish', async () => {
    const frames = [
      { choices: [{ index: 0, delta: { reasoning_content: 'think' }, finish_reason: null }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', function: { name: 'a', arguments: '{' } },
                { index: 1, id: 'call_b', function: { name: 'b', arguments: '{}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      },
    ];
    const response = sse(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
    );
    const events = await collect(
      new OpenAIWireAdapter('chat').events(response, new AbortController().signal)
    );

    expect(events).toContainEqual({ type: 'reasoning', value: 'think' });
    expect(events).toContainEqual({ type: 'tool-start', index: 0, id: 'call_a', name: 'a' });
    expect(events).toContainEqual({ type: 'tool-arguments', index: 0, value: '}' });
    expect(events).toContainEqual({ type: 'usage', input: 4, output: 3 });
    expect(events).toContainEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('parses Responses text, parallel function calls, and completion usage', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'hello' },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_a', name: 'a' },
      },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
      {
        type: 'response.completed',
        response: {
          output: [{ type: 'function_call' }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ];
    const response = sse(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
    );
    const output = await collect(
      new OpenAIWireAdapter('responses').events(response, new AbortController().signal)
    );

    expect(output).toContainEqual({ type: 'text', value: 'hello' });
    expect(output).toContainEqual({ type: 'tool-start', index: 0, id: 'call_a', name: 'a' });
    expect(output).toContainEqual({ type: 'usage', input: 5, output: 2 });
    expect(output.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });
});

function captured(protocol: CapturedRequest['protocol']): CapturedRequest {
  return {
    url:
      protocol === 'chat'
        ? 'https://api.openai.test/v1/chat/completions'
        : 'https://api.openai.test/v1/responses',
    method: 'POST',
    headers: new Headers({ authorization: 'Bearer secret' }),
    body:
      protocol === 'chat'
        ? { model: 'upstream-model', messages: [{ role: 'user', content: 'burner sentinel' }] }
        : { model: 'upstream-model', input: [{ role: 'user', content: 'burner sentinel' }] },
    protocol,
  };
}

function sse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const output: ProviderEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

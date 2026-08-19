import { describe, expect, it } from 'bun:test';
import type { AssistantMessage, Part } from '@opencode-ai/sdk';

import type { ParsedChatCompletionRequest } from '../src/openai/types.ts';
import type { OpenCodeSessionClient, PromptResult } from '../src/opencode/client.ts';
import { EventHub } from '../src/opencode/event-hub.ts';
import { SessionRunner } from '../src/opencode/session-runner.ts';
import type { StatelessPrompt } from '../src/transcript.ts';
import { DispatcherRegistry } from '../src/tools/registry.ts';

class FakeClient implements OpenCodeSessionClient {
  readonly aborted: string[] = [];
  readonly deleted: string[] = [];
  createImpl: () => Promise<string> = async () => 'session';
  promptImpl: () => Promise<PromptResult> = async () => promptResult('hello');

  async providers() {
    return [
      {
        id: 'provider',
        models: [{ id: 'model', capabilities: { image: true, tools: true } }],
      },
    ];
  }

  async createSession(): Promise<string> {
    return this.createImpl();
  }

  async prompt(
    _sessionID: string,
    _providerID: string,
    _modelID: string,
    _prompt: StatelessPrompt
  ): Promise<PromptResult> {
    return this.promptImpl();
  }

  async abortSession(sessionID: string): Promise<void> {
    this.aborted.push(sessionID);
  }

  async deleteSession(sessionID: string): Promise<void> {
    this.deleted.push(sessionID);
  }
}

describe('SessionRunner', () => {
  it('returns text and always deletes a successful burner session', async () => {
    const client = new FakeClient();
    const runner = new SessionRunner(client, new EventHub(), new DispatcherRegistry());

    const completion = await runner.run(request());

    expect(completion.text).toBe('hello');
    expect(completion.finishReason).toBe('stop');
    expect(client.aborted).toEqual([]);
    expect(client.deleted).toEqual(['session']);
  });

  it('aborts and deletes when prompting fails', async () => {
    const client = new FakeClient();
    client.promptImpl = async () => {
      throw new Error('provider secret');
    };
    const runner = new SessionRunner(client, new EventHub(), new DispatcherRegistry());

    await expect(runner.run(request())).rejects.toMatchObject({
      status: 502,
      message: 'The OpenCode request failed.',
    });
    expect(client.aborted).toEqual(['session']);
    expect(client.deleted).toEqual(['session']);
  });

  it('captures a validated tool call, aborts the prompt, and deletes the session', async () => {
    const client = new FakeClient();
    const registry = new DispatcherRegistry();
    client.promptImpl = () => {
      registry.before('session', 'oc-call', {
        name: 'weather',
        arguments: { city: 'Paris' },
      });
      registry.dispatch('session', 'assistant', 'weather', { city: 'Paris' });
      return new Promise<PromptResult>(() => undefined);
    };
    const runner = new SessionRunner(client, new EventHub(), registry);

    const completion = await runner.run(request(true));

    expect(completion.finishReason).toBe('tool_calls');
    expect(completion.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call_7_oc-call',
        name: 'weather',
        arguments: '{"city":"Paris"}',
      }),
    ]);
    expect(client.aborted).toEqual(['session']);
    expect(client.deleted).toEqual(['session']);
  });

  it('rejects new work after shutdown begins', async () => {
    const client = new FakeClient();
    const runner = new SessionRunner(client, new EventHub(), new DispatcherRegistry());
    await runner.shutdown();

    await expect(runner.run(request())).rejects.toMatchObject({ status: 503 });
    expect(client.deleted).toEqual([]);
  });

  it('deletes a session that finishes creating after client cancellation', async () => {
    const client = new FakeClient();
    const creation = Promise.withResolvers<string>();
    client.createImpl = () => creation.promise;
    const runner = new SessionRunner(client, new EventHub(), new DispatcherRegistry());
    const controller = new AbortController();
    const result = runner.run(request(), { signal: controller.signal });

    controller.abort('cancelled');
    creation.resolve('session');

    await expect(result).rejects.toMatchObject({ status: 499 });
    expect(client.aborted).toEqual([]);
    expect(client.deleted).toEqual(['session']);
  });
});

function request(withTool = false): ParsedChatCompletionRequest {
  return {
    model: 'provider/model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    stream: false,
    tools: withTool
      ? [
          {
            type: 'function',
            function: {
              name: 'weather',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          },
        ]
      : [],
  };
}

function promptResult(text: string): PromptResult {
  return {
    info: {
      id: 'assistant',
      sessionID: 'session',
      role: 'assistant',
      tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: 'stop',
    } as AssistantMessage,
    parts: [
      {
        id: 'part',
        sessionID: 'session',
        messageID: 'assistant',
        type: 'text',
        text,
      } as Part,
    ],
  };
}

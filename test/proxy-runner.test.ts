import { afterEach, describe, expect, it } from 'bun:test';

import type { ProviderCatalogEntry } from '../src/openai/models.ts';
import { parseChatCompletionRequest } from '../src/openai/parse.ts';
import type { OpenCodeProxyClient } from '../src/opencode/client.ts';
import { CAPTURE_HEADER, CaptureManager } from '../src/proxy/capture.ts';
import { ProxyRunner } from '../src/proxy/runner.ts';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
});

class FakeClient implements OpenCodeProxyClient {
  readonly aborted: string[] = [];
  readonly deleted: string[] = [];
  runner?: ProxyRunner;

  async providers(): Promise<ProviderCatalogEntry[]> {
    return [
      {
        id: 'provider',
        models: [{ id: 'model', capabilities: { image: true, tools: true } }],
      },
    ];
  }

  async createSession(): Promise<string> {
    return 'burner';
  }

  async promptCapture(): Promise<void> {
    const marker = this.runner?.markerFor('burner');
    if (!marker) throw new Error('Missing capture marker.');
    const response = await globalThis.fetch('https://provider.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CAPTURE_HEADER]: marker },
      body: JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'capture' }] }),
    });
    await response.text();
  }

  async abortSession(sessionID: string): Promise<void> {
    this.aborted.push(sessionID);
  }

  async deleteSession(sessionID: string): Promise<void> {
    this.deleted.push(sessionID);
  }
}

describe('ProxyRunner', () => {
  it('captures without inference, sends one rewritten request, and deletes the burner', async () => {
    const realBodies: Record<string, unknown>[] = [];
    globalThis.fetch = fakeFetch(async (_input, init) => {
      realBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\n`,
          'data: [DONE]\n\n',
        ].join(''),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    });
    const capture = new CaptureManager();
    const client = new FakeClient();
    const runner = new ProxyRunner(client, capture);
    client.runner = runner;

    const completion = await runner.run(
      parseChatCompletionRequest({
        model: 'provider/model',
        messages: [{ role: 'user', content: 'real user input' }],
      })
    );

    expect(completion).toMatchObject({ text: 'hello', finishReason: 'stop' });
    expect(realBodies).toHaveLength(1);
    expect(realBodies[0].messages).toEqual([{ role: 'user', content: 'real user input' }]);
    expect(JSON.stringify(realBodies[0])).not.toContain('capture');
    expect(client.aborted).toEqual([]);
    expect(client.deleted).toEqual(['burner']);
    capture.dispose();
  });
});

function fakeFetch(
  implementation: (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1]
  ) => Promise<Response>
): typeof fetch {
  return Object.assign(implementation, { preconnect: (): void => undefined });
}

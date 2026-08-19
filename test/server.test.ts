import { describe, expect, it } from 'bun:test';

import { parseServerOptions } from '../src/config.ts';
import { MAX_REQUEST_BODY_BYTES } from '../src/constants.ts';
import { createRouter, type RouterDependencies } from '../src/http/router.ts';
import type { NormalizedCompletion } from '../src/openai/types.ts';

describe('HTTP router', () => {
  it('authenticates and returns both versions', async () => {
    const router = createRouter(dependencies({ token: 'secret' }));

    const denied = await router(new Request('http://localhost/version'));
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe('Bearer');

    const response = await router(
      new Request('http://localhost/v1/version', {
        headers: { authorization: 'Bearer secret' },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: 'version',
      plugin: '0.0.1',
      opencode: '1.18.15',
    });

    const oldRoute = await router(
      new Request('http://localhost/version', {
        headers: { authorization: 'Bearer secret' },
      })
    );
    expect(oldRoute.status).toBe(404);
  });

  it('lists canonical provider/model IDs', async () => {
    const router = createRouter(dependencies());
    const response = await router(new Request('http://localhost/v1/models'));

    expect(await response.json()).toMatchObject({
      object: 'list',
      data: [{ id: 'provider/model', object: 'model', owned_by: 'provider' }],
    });
  });

  it('returns a non-streaming Chat Completion', async () => {
    const router = createRouter(dependencies());
    const response = await router(chatRequest(false));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    });
  });

  it('streams OpenAI-compatible chunks and DONE', async () => {
    const router = createRouter(dependencies());
    const response = await router(chatRequest(true));
    const body = await response.text();

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(body).toContain('"role":"assistant"');
    expect(body).toContain('"content":"live"');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toEndWith('data: [DONE]\n\n');
  });

  it('rejects a body while reading once it exceeds the byte limit', async () => {
    const router = createRouter(dependencies());
    const request = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      body: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1),
    });
    const response = await router(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'request_too_large' } });
  });
});

function dependencies(options: { token?: string } = {}): RouterDependencies {
  return {
    options: parseServerOptions(options),
    openCodeVersion: '1.18.15',
    pluginVersion: '0.0.1',
    isDraining: () => false,
    client: {
      async providers() {
        return [
          {
            id: 'provider',
            models: [{ id: 'model', capabilities: { image: true, tools: true } }],
          },
        ];
      },
    },
    runner: {
      async run(_request, runOptions): Promise<NormalizedCompletion> {
        runOptions?.onEvent?.({ type: 'text', value: 'live' });
        return {
          id: runOptions?.identity?.id ?? 'chatcmpl-test',
          created: runOptions?.identity?.created ?? 1,
          model: 'provider/model',
          text: 'hello',
          reasoning: '',
          toolCalls: [],
          finishReason: 'stop',
        };
      },
    },
  };
}

function chatRequest(stream: boolean): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'provider/model',
      messages: [{ role: 'user', content: 'hello' }],
      stream,
    }),
  });
}

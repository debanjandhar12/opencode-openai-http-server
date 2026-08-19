import { afterEach, describe, expect, it } from 'bun:test';

import { CAPTURE_HEADER, CaptureManager } from '../src/proxy/capture.ts';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
});

describe('CaptureManager', () => {
  it('captures marked provider requests without forwarding them', async () => {
    let forwarded = 0;
    globalThis.fetch = fakeFetch(async () => {
      forwarded++;
      return new Response('forwarded');
    });
    const manager = new CaptureManager();
    const marker = crypto.randomUUID();
    const captured = manager.register(marker);

    const synthetic = await globalThis.fetch('https://provider.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
        [CAPTURE_HEADER]: marker,
      },
      body: JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'capture' }] }),
    });
    const request = await captured;

    expect(forwarded).toBe(0);
    expect(request.protocol).toBe('chat');
    expect(request.headers.get('authorization')).toBe('Bearer secret');
    expect(request.headers.has(CAPTURE_HEADER)).toBe(false);
    expect(await synthetic.text()).toContain('[DONE]');

    await expect(
      globalThis.fetch('https://provider.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CAPTURE_HEADER]: marker },
        body: JSON.stringify({ model: 'model', messages: [] }),
      })
    ).rejects.toMatchObject({ code: 'unsupported_provider' });
    expect(forwarded).toBe(0);
    manager.dispose();
  });

  it('passes unrelated requests through and restores fetch on disposal', async () => {
    const base = fakeFetch(async () => new Response('forwarded'));
    globalThis.fetch = base;
    const first = new CaptureManager();
    const second = new CaptureManager();

    expect(await (await globalThis.fetch('https://auth.test/token')).text()).toBe('forwarded');
    first.dispose();
    expect(globalThis.fetch).not.toBe(base);
    second.dispose();
    expect(globalThis.fetch).toBe(base);
  });

  it('loads when the runtime fetch does not implement Bun preconnect', () => {
    const withoutPreconnect = (async () => new Response('forwarded')) as unknown as typeof fetch;
    globalThis.fetch = withoutPreconnect;

    const manager = new CaptureManager();

    expect(typeof globalThis.fetch.preconnect).toBe('function');
    manager.dispose();
    expect(globalThis.fetch).toBe(withoutPreconnect);
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

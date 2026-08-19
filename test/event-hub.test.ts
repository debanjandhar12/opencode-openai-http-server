import { describe, expect, it } from 'bun:test';
import type { Event } from '@opencode-ai/sdk';

import type { CompletionDelta } from '../src/opencode/event-hub.ts';
import { EventHub } from '../src/opencode/event-hub.ts';

function partEvent(
  sessionID: string,
  id: string,
  text: string,
  delta?: string,
  type: 'text' | 'reasoning' = 'text'
): Event {
  return {
    type: 'message.part.updated',
    properties: {
      part: { type, sessionID, messageID: 'message', id, text },
      ...(delta === undefined ? {} : { delta }),
    },
  } as unknown as Event;
}

function assistantEvent(sessionID: string): Event {
  return {
    type: 'message.updated',
    properties: {
      info: {
        id: 'message',
        sessionID,
        role: 'assistant',
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
  } as unknown as Event;
}

describe('EventHub', () => {
  it('routes deltas only to their registered session', () => {
    const hub = new EventHub();
    const first: CompletionDelta[] = [];
    const second: CompletionDelta[] = [];
    hub.register('first', { onDelta: (delta) => first.push(delta), onError: () => undefined });
    hub.register('second', { onDelta: (delta) => second.push(delta), onError: () => undefined });
    hub.handle(assistantEvent('first'));
    hub.handle(assistantEvent('second'));

    hub.handle(partEvent('first', 'part', 'hello', 'hello'));
    hub.handle(partEvent('unknown', 'part', 'ignored', 'ignored'));

    expect(first).toEqual([{ type: 'text', value: 'hello' }]);
    expect(second).toEqual([]);
  });

  it('derives cumulative suffixes and does not repeat a duplicate cumulative update', () => {
    const hub = new EventHub();
    const deltas: CompletionDelta[] = [];
    hub.register('session', { onDelta: (delta) => deltas.push(delta), onError: () => undefined });
    hub.handle(assistantEvent('session'));

    hub.handle(partEvent('session', 'part', 'hel'));
    hub.handle(partEvent('session', 'part', 'hello'));
    hub.handle(partEvent('session', 'part', 'hello'));
    hub.handle(partEvent('session', 'reason', 'why', undefined, 'reasoning'));

    expect(deltas).toEqual([
      { type: 'text', value: 'hel' },
      { type: 'text', value: 'lo' },
      { type: 'reasoning', value: 'why' },
    ]);
  });

  it('routes session errors and stops routing after unregister', () => {
    const hub = new EventHub();
    const errors: unknown[] = [];
    hub.register('session', { onDelta: () => undefined, onError: (error) => errors.push(error) });
    hub.handle({
      type: 'session.error',
      properties: { sessionID: 'session', error: { name: 'UpstreamError' } },
    } as unknown as Event);
    hub.unregister('session');
    hub.handle(partEvent('session', 'part', 'late', 'late'));

    expect(errors).toEqual([{ name: 'UpstreamError' }]);
  });
});

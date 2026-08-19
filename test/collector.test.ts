import { describe, expect, it } from 'bun:test';

import { ToolCallCollector } from '../src/tools/collector.ts';

describe('ToolCallCollector', () => {
  it('collects calls in arrival order and deduplicates IDs', async () => {
    const collector = new ToolCallCollector({ quietMs: 10, deadlineMs: 100 });
    expect(collector.capture({ id: 'call_a', name: 'a', arguments: '{}' })).toBe(true);
    expect(collector.capture({ id: 'call_a', name: 'a', arguments: '{}' })).toBe(false);
    expect(collector.capture({ id: 'call_b', name: 'b', arguments: '{"x":1}' })).toBe(true);

    await expect(collector.wait()).resolves.toEqual({
      type: 'tool_calls',
      calls: [
        { id: 'call_a', name: 'a', arguments: '{}', index: 0 },
        { id: 'call_b', name: 'b', arguments: '{"x":1}', index: 1 },
      ],
    });
  });

  it('closes immediately at maximum calls', async () => {
    const collector = new ToolCallCollector({ quietMs: 100, deadlineMs: 100, maxCalls: 1 });
    collector.capture({ id: 'call_a', name: 'a', arguments: '{}' });
    expect(await collector.wait()).toMatchObject({ type: 'tool_calls' });
    expect(collector.state).toBe('closed');
  });

  it('signals exhausted invalid attempts only when no valid call exists', async () => {
    const collector = new ToolCallCollector({ maxInvalidAttempts: 2 });
    expect(collector.recordInvalidAttempt()).toBe(false);
    expect(collector.recordInvalidAttempt()).toBe(true);
    expect(await collector.wait()).toEqual({ type: 'invalid_exhausted', calls: [] });
  });

  it('returns captured snapshots when explicitly closed', async () => {
    const collector = new ToolCallCollector({ quietMs: 1_000, deadlineMs: 1_000 });
    collector.capture({ id: 'call_a', name: 'a', arguments: '{}' });
    collector.close();
    expect(await collector.wait()).toMatchObject({ type: 'closed', calls: [{ index: 0 }] });
  });
});

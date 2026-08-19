import { describe, expect, it } from 'bun:test';

import type { NormalizedFunctionTool } from '../src/openai/types.ts';
import { ToolCallCollector } from '../src/tools/collector.ts';
import { DispatcherRegistry } from '../src/tools/registry.ts';

function tool(required: string): NormalizedFunctionTool {
  return {
    type: 'function',
    function: {
      name: 'lookup',
      parameters: {
        type: 'object',
        properties: { [required]: { type: 'string' } },
        required: [required],
        additionalProperties: false,
      },
    },
  };
}

describe('DispatcherRegistry', () => {
  it('captures only schema-valid arguments with stable call metadata', () => {
    const registry = new DispatcherRegistry();
    const collector = new ToolCallCollector();
    registry.register('session', registry.prepare([tool('city')]), collector);
    registry.before('session', 'opaque-id', {
      name: 'lookup',
      arguments: '{"city":"Paris"}',
    });

    expect(registry.dispatch('session', 'message-1', 'lookup', '{"city":"Paris"}')).toEqual({
      type: 'captured',
      call: {
        id: 'call_9_opaque-id',
        name: 'lookup',
        arguments: '{"city":"Paris"}',
        index: 0,
        openCodeCallID: 'opaque-id',
        messageID: 'message-1',
      },
    });
    registry.unregister('session');
  });

  it('returns retry feedback and exhausts the invalid-attempt budget', async () => {
    const registry = new DispatcherRegistry();
    const collector = new ToolCallCollector({ maxInvalidAttempts: 2 });
    registry.register('session', registry.prepare([tool('city')]), collector);

    registry.before('session', 'first', { name: 'lookup', arguments: { city: 1 } });
    expect(registry.dispatch('session', 'message', 'lookup', { city: 1 })).toMatchObject({
      type: 'invalid',
      exhausted: false,
    });
    registry.before('session', 'second', { name: 'missing', arguments: {} });
    expect(registry.dispatch('session', 'message', 'missing', {})).toMatchObject({
      type: 'invalid',
      exhausted: true,
    });
    await expect(collector.wait()).resolves.toEqual({ type: 'invalid_exhausted', calls: [] });
    registry.unregister('session');
  });

  it('rejects non-object function arguments even when the schema permits them', () => {
    const registry = new DispatcherRegistry();
    const collector = new ToolCallCollector();
    const permissive: NormalizedFunctionTool = {
      type: 'function',
      function: { name: 'lookup', parameters: true },
    };
    registry.register('session', registry.prepare([permissive]), collector);
    registry.before('session', 'primitive', { name: 'lookup', arguments: 42 });

    expect(registry.dispatch('session', 'message', 'lookup', 42)).toMatchObject({
      type: 'invalid',
      errors: [{ path: '/arguments', keyword: 'type' }],
    });
    expect(collector.snapshots()).toEqual([]);
    registry.unregister('session');
  });

  it('rejects unauthorized sessions without revealing registered tools', () => {
    const registry = new DispatcherRegistry();
    const collector = new ToolCallCollector();
    registry.register('authorized', registry.prepare([tool('secretField')]), collector);

    expect(() => registry.before('ordinary-session', 'call', { name: 'lookup' })).toThrow(
      'Dispatcher is only available to OpenAI API burner sessions.'
    );
    expect(() => registry.dispatch('ordinary-session', 'message', 'lookup', {})).toThrow(
      'Dispatcher is only available to OpenAI API burner sessions.'
    );
    registry.unregister('authorized');
  });

  it('isolates concurrent sessions with identical tool names and different schemas', () => {
    const registry = new DispatcherRegistry();
    const first = new ToolCallCollector();
    const second = new ToolCallCollector();
    registry.register('first', registry.prepare([tool('city')]), first);
    registry.register('second', registry.prepare([tool('zip')]), second);

    registry.before('first', 'a', { name: 'lookup', arguments: { city: 'Paris' } });
    registry.before('second', 'b', { name: 'lookup', arguments: { city: 'Paris' } });
    expect(registry.dispatch('first', 'm1', 'lookup', { city: 'Paris' }).type).toBe('captured');
    expect(registry.dispatch('second', 'm2', 'lookup', { city: 'Paris' }).type).toBe('invalid');
    expect(first.snapshots()).toHaveLength(1);
    expect(second.snapshots()).toHaveLength(0);

    registry.unregister('first');
    registry.unregister('second');
  });
});

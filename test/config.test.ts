import { describe, expect, it } from 'bun:test';

import { parseServerOptions } from '../src/config.ts';
import { ProtocolError } from '../src/errors.ts';

describe('parseServerOptions', () => {
  it('uses secure loopback defaults', () => {
    expect(parseServerOptions()).toEqual({ host: '127.0.0.1', port: 4097, cors: false });
  });

  it.each([
    [{ extra: true }, 'extra'],
    [{ host: '' }, 'host'],
    [{ port: 1.5 }, 'port'],
    [{ port: 65_536 }, 'port'],
    [{ cors: [''] }, 'cors'],
    [{ token: '' }, 'token'],
  ] as const)('rejects invalid options %#', (options, param) => {
    try {
      parseServerOptions(options);
      throw new Error('Expected option parsing to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).param).toBe(param);
    }
  });

  it('requires a token outside loopback and preserves a supplied token', () => {
    expect(() => parseServerOptions({ host: '0.0.0.0' })).toThrow(
      'A token is required when binding outside loopback.'
    );
    expect(parseServerOptions({ host: '0.0.0.0', token: 'secret' })).toMatchObject({
      host: '0.0.0.0',
      token: 'secret',
    });
  });
});

import { describe, expect, it } from 'bun:test';

import { ProtocolError } from '../src/errors.ts';
import { compileSchema } from '../src/tools/schema-validator.ts';

describe('compileSchema', () => {
  it('supports formats and leaves arguments untouched', () => {
    const compiled = compileSchema({
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        count: { type: 'number', default: 4 },
      },
      required: ['email'],
      additionalProperties: false,
    });
    const input = { email: 'not-an-email', extra: true };

    expect(compiled.validate(input)).toBe(false);
    expect(input).toEqual({ email: 'not-an-email', extra: true });
    expect(compiled.errors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'format' }),
        expect.objectContaining({ keyword: 'additionalProperties' }),
      ])
    );
  });

  it('supports declared 2020-12 schemas', () => {
    const compiled = compileSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'array',
      prefixItems: [{ type: 'string' }],
      items: false,
    });
    expect(compiled.validate(['ok'])).toBe(true);
    expect(compiled.validate(['ok', 'extra'])).toBe(false);
  });

  it('rejects unresolved schemas', () => {
    expect(() => compileSchema({ $ref: 'https://unavailable.example/schema' })).toThrow(
      ProtocolError
    );
  });
});

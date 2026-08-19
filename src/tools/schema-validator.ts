import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { MAX_VALIDATION_ERROR_BYTES, MAX_VALIDATION_ERRORS } from '../constants.ts';
import { ProtocolError } from '../errors.ts';
import type { JsonSchema, JsonValue } from '../openai/types.ts';

export interface SchemaValidationError {
  path: string;
  keyword: string;
  message: string;
}

export interface CompiledSchema {
  validate(value: unknown): value is JsonValue;
  errors(): SchemaValidationError[];
}

export function compileSchema(schema: JsonSchema): CompiledSchema {
  const ajv = createAjv(schema);
  let validator: ValidateFunction;
  try {
    validator = ajv.compile(schema);
  } catch {
    throw new ProtocolError(
      400,
      'invalid_schema',
      'Tool parameters contain an invalid or unresolved JSON Schema.',
      'tools'
    );
  }

  let latestErrors: SchemaValidationError[] = [];
  return {
    validate(value: unknown): value is JsonValue {
      const valid = validator(value) as boolean;
      latestErrors = valid ? [] : sanitizeErrors(validator.errors);
      return valid;
    },
    errors(): SchemaValidationError[] {
      return latestErrors.map((error) => ({ ...error }));
    },
  };
}

function createAjv(schema: JsonSchema): Ajv | Ajv2019 | Ajv2020 {
  const dialect = typeof schema === 'boolean' ? undefined : schema.$schema;
  const options = {
    allErrors: true,
    strict: false,
    coerceTypes: false as const,
    useDefaults: false as const,
    removeAdditional: false as const,
  };
  const ajv =
    typeof dialect === 'string' && dialect.includes('2020-12')
      ? new Ajv2020(options)
      : typeof dialect === 'string' && dialect.includes('2019-09')
        ? new Ajv2019(options)
        : new Ajv(options);
  addFormats(ajv);
  return ajv;
}

function sanitizeErrors(errors: ErrorObject[] | null | undefined): SchemaValidationError[] {
  const sanitized: SchemaValidationError[] = [];
  let bytes = 0;
  for (const error of (errors ?? []).slice(0, MAX_VALIDATION_ERRORS)) {
    const item = {
      path: error.instancePath || '/',
      keyword: error.keyword,
      message: error.message ?? 'is invalid',
    };
    const itemBytes = new globalThis.TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (bytes + itemBytes > MAX_VALIDATION_ERROR_BYTES) break;
    sanitized.push(item);
    bytes += itemBytes;
  }
  return sanitized;
}

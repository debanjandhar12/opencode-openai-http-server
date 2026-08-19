export type OpenAIErrorCode =
  | 'invalid_request_error'
  | 'invalid_schema'
  | 'invalid_image'
  | 'model_not_found'
  | 'invalid_api_key'
  | 'request_too_large'
  | 'tool_arguments_invalid'
  | 'upstream_error'
  | 'service_unavailable'
  | 'request_timeout'
  | 'internal_error';

export type OpenAIErrorType =
  'invalid_request_error' | 'authentication_error' | 'unprocessable_entity_error' | 'server_error';

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: OpenAIErrorType;
    param: string | null;
    code: OpenAIErrorCode;
  };
}

export class ProtocolError extends Error {
  readonly status: number;
  readonly code: OpenAIErrorCode;
  readonly type: OpenAIErrorType;
  readonly param: string | null;

  constructor(
    status: number,
    code: OpenAIErrorCode,
    message: string,
    param: string | null = null,
    type: OpenAIErrorType = status >= 500 ? 'server_error' : 'invalid_request_error'
  ) {
    super(message);
    this.name = 'ProtocolError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.param = param;
  }
}

export function invalidRequest(message: string, param: string | null = null): ProtocolError {
  return new ProtocolError(400, 'invalid_request_error', message, param);
}

export function errorBody(error: unknown): OpenAIErrorBody {
  const protocolError =
    error instanceof ProtocolError
      ? error
      : new ProtocolError(500, 'internal_error', 'An internal error occurred.');

  return {
    error: {
      message: protocolError.message,
      type: protocolError.type,
      param: protocolError.param,
      code: protocolError.code,
    },
  };
}

export function errorStatus(error: unknown): number {
  return error instanceof ProtocolError ? error.status : 500;
}

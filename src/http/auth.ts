import { ProtocolError } from '../errors.ts';

export function authenticate(request: Request, token?: string): void {
  if (token === undefined) return;
  const authorization = request.headers.get('authorization');
  if (authorization !== `Bearer ${token}`) {
    throw new ProtocolError(
      401,
      'invalid_api_key',
      'Invalid authentication credentials.',
      null,
      'authentication_error'
    );
  }
}

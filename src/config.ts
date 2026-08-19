import { invalidRequest } from './errors.ts';

export interface OpenAIHttpServerOptions {
  host?: string;
  port?: number;
  cors?: boolean | string[];
  token?: string;
}

export interface ResolvedServerOptions {
  host: string;
  port: number;
  cors: boolean | string[];
  token?: string;
}

const OPTION_KEYS = new Set(['host', 'port', 'cors', 'token']);

export function parseServerOptions(options: Record<string, unknown> = {}): ResolvedServerOptions {
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw invalidRequest(`Unknown plugin option: ${key}.`, key);
  }

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4097;
  const cors = options.cors ?? false;
  const token = options.token;

  if (typeof host !== 'string' || host.trim().length === 0)
    throw invalidRequest('host must be a non-empty string.', 'host');
  if (!Number.isInteger(port) || typeof port !== 'number' || port < 0 || port > 65535)
    throw invalidRequest('port must be an integer between 0 and 65535.', 'port');
  if (
    typeof cors !== 'boolean' &&
    (!Array.isArray(cors) || cors.some((origin) => typeof origin !== 'string' || !origin))
  ) {
    throw invalidRequest('cors must be a boolean or an array of origins.', 'cors');
  }
  if (token !== undefined && (typeof token !== 'string' || token.length === 0))
    throw invalidRequest('token must be a non-empty string.', 'token');
  if (!isLoopback(host) && token === undefined)
    throw invalidRequest('A token is required when binding outside loopback.', 'token');

  return {
    host,
    port,
    cors: Array.isArray(cors) ? [...cors] : cors,
    ...(typeof token === 'string' ? { token } : {}),
  };
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

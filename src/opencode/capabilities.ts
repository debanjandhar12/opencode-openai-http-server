import { ProtocolError } from '../errors.ts';

export interface OpenCodeHealth {
  healthy: true;
  version: string;
}

export async function checkOpenCodeHealth(serverUrl: URL): Promise<OpenCodeHealth> {
  const url = new URL('/global/health', serverUrl);
  const signal = AbortSignal.timeout(5_000);
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch {
    throw new ProtocolError(503, 'service_unavailable', 'OpenCode server is unavailable.');
  }
  if (!response.ok) {
    throw new ProtocolError(503, 'service_unavailable', 'OpenCode health check failed.');
  }
  const value = (await response.json()) as Partial<OpenCodeHealth>;
  if (value.healthy !== true || typeof value.version !== 'string') {
    throw new ProtocolError(503, 'service_unavailable', 'OpenCode health response is invalid.');
  }
  const [major, minor] = value.version.split('.').map(Number);
  if (major !== 1 || !Number.isInteger(minor) || minor < 18) {
    throw new ProtocolError(
      503,
      'service_unavailable',
      `OpenCode ${value.version} is not supported; version 1.18 or newer is required.`
    );
  }
  return { healthy: true, version: value.version };
}

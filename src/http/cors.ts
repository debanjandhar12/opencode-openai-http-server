import type { ResolvedServerOptions } from '../config.ts';

export function corsHeaders(request: Request, cors: ResolvedServerOptions['cors']): Headers {
  const headers = new Headers();
  if (cors === false) return headers;
  const origin = request.headers.get('origin');
  if (cors === true) headers.set('Access-Control-Allow-Origin', '*');
  else if (origin && cors.includes(origin)) headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  if (cors !== true) headers.append('Vary', 'Origin');
  return headers;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function textResponse(body: string, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
  return new Response(body, { ...init, headers });
}

export function methodNotAllowed(allowed: string[]) {
  return jsonResponse({ error: 'Method Not Allowed' }, { status: 405, headers: { allow: allowed.join(', ') } });
}


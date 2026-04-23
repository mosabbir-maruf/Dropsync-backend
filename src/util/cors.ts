const ALLOWED_ORIGINS = new Set<string>([
  'http://localhost:3000',
  'https://dropsyncgo.vercel.app',
  'https://dropsyncgo.vercel.app/'
]);

export function corsHeaders(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-allow-credentials': 'true',
    'vary': 'Origin'
  };

  // Mirror Node behavior: allow no-origin requests (curl/mobile).
  if (!origin || ALLOWED_ORIGINS.has(origin)) {
    if (origin) headers['access-control-allow-origin'] = origin;
    else headers['access-control-allow-origin'] = '*';
  }

  return headers;
}

export function withCors(req: Request, res: Response) {
  const h = new Headers(res.headers);
  const add = corsHeaders(req);
  for (const [k, v] of Object.entries(add)) {
    if (v) h.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export function handlePreflight(req: Request) {
  const headers = corsHeaders(req);
  return new Response(null, { status: 204, headers });
}


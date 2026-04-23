import type { Env } from './env';
import { RoomDO } from './do/RoomDO';
import { RegistryDO } from './do/RegistryDO';
import { handlePreflight, withCors } from './util/cors';
import { jsonResponse, methodNotAllowed } from './util/http';
import { handleHealth } from './http/health';

export { RoomDO, RegistryDO };

async function handleWs(req: Request, env: Env) {
  // Single hub DO to preserve the existing Node behavior (one connection can join/leave multiple rooms).
  const id = env.ROOM_DO.idFromName('hub');
  const stub = env.ROOM_DO.get(id);
  // Important: create a new Request so the DO sees the correct path/URL while preserving upgrade headers.
  return stub.fetch(new Request('https://roomdo/ws', req));
}

async function ensureInitialized(env: Env) {
  const hubId = env.ROOM_DO.idFromName('hub');
  const hub = env.ROOM_DO.get(hubId);
  // idempotent
  await hub.fetch('https://roomdo/init', { method: 'POST' });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return handlePreflight(req);

    // WebSocket upgrade
    const upgrade = req.headers.get('upgrade');
    if (upgrade && upgrade.toLowerCase() === 'websocket') {
      // Do not wrap/clone WS upgrade responses.
      return handleWs(req, env);
    }

    // Keep defaults warm (no-op after first init)
    ctx.waitUntil(ensureInitialized(env));

    if (url.pathname === '/') {
      if (req.method !== 'GET') return withCors(req, methodNotAllowed(['GET']));
      return withCors(
        req,
        jsonResponse({
          message: 'DropSync WebRTC Signaling Server (Cloudflare)',
          author: 'Mosabbir Maruf',
          version: '1.0.0',
          endpoints: { health: '/health', ping: '/ping' }
        })
      );
    }

    if (url.pathname === '/ping') {
      if (req.method !== 'GET') return withCors(req, methodNotAllowed(['GET']));
      return withCors(
        req,
        jsonResponse({
          message: 'pong',
          timestamp: new Date().toISOString(),
          author: 'Mosabbir Maruf'
        })
      );
    }

    if (url.pathname === '/health') {
      if (req.method !== 'GET') return withCors(req, methodNotAllowed(['GET']));
      const res = await handleHealth(env);
      return withCors(req, res);
    }

    return withCors(req, jsonResponse({ error: 'Not Found' }, { status: 404 }));
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Trigger registry cleanup
    ctx.waitUntil(
      (async () => {
        const id = env.REGISTRY_DO.idFromName('registry');
        const stub = env.REGISTRY_DO.get(id);
        await stub.fetch('https://registry/cleanup-expired', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({})
        });
      })()
    );
  }
};


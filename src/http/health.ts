import type { Env } from '../env';
import { jsonResponse } from '../util/http';

export async function handleHealth(env: Env) {
  const id = env.ROOM_DO.idFromName('hub');
  const stub = env.ROOM_DO.get(id);
  const res = await stub.fetch('https://roomdo/stats');
  const stats = await res.json<any>();

  return jsonResponse({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    author: 'Mosabbir Maruf',
    version: '1.0.0',
    connections: {
      websocket: stats.websocket ?? 0,
      rooms: stats.rooms ?? 0,
      clients: stats.clients ?? 0
    }
  });
}


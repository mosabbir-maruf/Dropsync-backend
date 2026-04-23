import { jsonResponse } from '../util/http';

type RoomMeta = {
  id: string;
  name: string;
  isPublic: boolean;
  passwordHash: string | null;
  createdBy: string;
  adminId: string;
  description: string;
  isSecure: boolean;
  createdAt: number;
};

type RegistryState = {
  rooms: Record<string, RoomMeta>;
};

const STATE_KEY = 'state:v1';
const HARDCODED_ROOMS = ['retro-realm', 'sanctuary', 'lobby'] as const;

function sha256Hex(input: string) {
  // Cloudflare Workers: crypto.subtle is available (async); this DO uses it sparingly.
  // Callers that already have hashes should pass them.
  return crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(input))
    .then((buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join(''));
}

async function loadState(storage: DurableObjectStorage): Promise<RegistryState> {
  const s = (await storage.get<RegistryState>(STATE_KEY)) ?? { rooms: {} };
  if (!s.rooms) s.rooms = {};
  return s;
}

async function saveState(storage: DurableObjectStorage, state: RegistryState) {
  await storage.put(STATE_KEY, state);
}

export class RegistryDO implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== 'POST') return jsonResponse({ error: 'Method Not Allowed' }, { status: 405 });

    let body: any = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    // Initialize default rooms once.
    if (path === '/init-defaults') {
      const now = Date.now();
      const st = await loadState(this.state.storage);
      if (!st.rooms['retro-realm']) {
        const passwordHash = await sha256Hex('theweekndxo');
        st.rooms['retro-realm'] = {
          id: 'retro-realm',
          name: 'Retro Realm',
          isPublic: false,
          passwordHash,
          createdBy: 'admin',
          adminId: 'admin',
          description:
            'Step into the Retro Realm! A private space to share memories, vintage finds, and good vibes.',
          isSecure: true,
          createdAt: now
        };
      }
      if (!st.rooms['sanctuary']) {
        st.rooms['sanctuary'] = {
          id: 'sanctuary',
          name: 'Sanctuary',
          isPublic: true,
          passwordHash: null,
          createdBy: 'admin',
          adminId: 'admin',
          description:
            'Welcome to Sanctuary! An open space for everyone to share messages and files freely. Join and connect with the community. We will not store your data.',
          isSecure: false,
          createdAt: now
        };
      }
      if (!st.rooms['lobby']) {
        st.rooms['lobby'] = {
          id: 'lobby',
          name: 'Lobby',
          isPublic: false,
          passwordHash: null,
          createdBy: 'system',
          adminId: 'system',
          description: '',
          isSecure: false,
          createdAt: now
        };
      }
      await saveState(this.state.storage, st);
      return jsonResponse({ ok: true });
    }

    if (path === '/create-room') {
      const { id, name, isPublic, passwordHash, createdBy, adminId, description, isSecure, createdAt } = body ?? {};
      if (!id || !name || !createdBy || !adminId) return jsonResponse({ error: 'Invalid payload' }, { status: 400 });
      const st = await loadState(this.state.storage);
      st.rooms[id] = {
        id,
        name,
        isPublic: !!isPublic,
        passwordHash: passwordHash ?? null,
        createdBy,
        adminId,
        description: description ?? '',
        isSecure: !!isSecure,
        createdAt: typeof createdAt === 'number' ? createdAt : Date.now()
      };
      await saveState(this.state.storage, st);
      return jsonResponse({ ok: true });
    }

    if (path === '/get-public-rooms') {
      const st = await loadState(this.state.storage);
      const rooms = Object.values(st.rooms)
        .filter((r) => r.isPublic)
        .map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          isPrivate: !r.isPublic,
          isSecure: r.isSecure
        }));
      return jsonResponse({ rooms });
    }

    if (path === '/get-room-info') {
      const roomId = body?.roomId;
      if (!roomId) return jsonResponse({ error: 'Room ID required' }, { status: 400 });
      const st = await loadState(this.state.storage);
      const meta = st.rooms[roomId];
      if (meta) {
        return jsonResponse({
          exists: true,
          roomId,
          name: meta.name,
          isSecure: !!meta.passwordHash,
          isPrivate: !meta.isPublic,
          description: meta.description ?? ''
        });
      }
      return jsonResponse({
        exists: false,
        roomId,
        name: `Room ${roomId}`,
        isSecure: false,
        isPrivate: false,
        description: ''
      });
    }

    if (path === '/get-room-meta') {
      const roomId = body?.roomId;
      if (!roomId) return jsonResponse({ error: 'Room ID required' }, { status: 400 });
      const st = await loadState(this.state.storage);
      const meta = st.rooms[roomId];
      if (meta) return jsonResponse({ roomId, name: meta.name, adminId: meta.adminId, exists: true });
      return jsonResponse({ roomId, name: `Room ${roomId}`, adminId: null, exists: false });
    }

    if (path === '/validate-room-password') {
      const { roomId, password } = body ?? {};
      if (!roomId) return jsonResponse({ error: 'Room ID required' }, { status: 400 });
      const st = await loadState(this.state.storage);
      const meta = st.rooms[roomId];
      if (!meta) return jsonResponse({ ok: false, error: 'Room not found' }, { status: 404 });
      if (!meta.passwordHash) return jsonResponse({ ok: true, isSecure: false });
      if (!password) return jsonResponse({ ok: false, error: 'Incorrect password' });
      const hash = await sha256Hex(String(password));
      return jsonResponse({ ok: hash === meta.passwordHash, error: hash === meta.passwordHash ? null : 'Incorrect password' });
    }

    if (path === '/set-admin') {
      const { roomId, adminId } = body ?? {};
      if (!roomId || !adminId) return jsonResponse({ error: 'Invalid payload' }, { status: 400 });
      const st = await loadState(this.state.storage);
      const meta = st.rooms[roomId];
      if (!meta) return jsonResponse({ error: 'Room not found' }, { status: 404 });
      meta.adminId = adminId;
      st.rooms[roomId] = meta;
      await saveState(this.state.storage, st);
      return jsonResponse({ ok: true });
    }

    if (path === '/delete-room') {
      const { roomId } = body ?? {};
      if (!roomId) return jsonResponse({ error: 'Room ID required' }, { status: 400 });
      const st = await loadState(this.state.storage);
      delete st.rooms[roomId];
      await saveState(this.state.storage, st);
      return jsonResponse({ ok: true });
    }

    if (path === '/cleanup-expired') {
      const now = Date.now();
      const EIGHT_HOURS = 8 * 60 * 60 * 1000;
      const st = await loadState(this.state.storage);

      let deleted = 0;
      for (const [roomId, meta] of Object.entries(st.rooms)) {
        if ((HARDCODED_ROOMS as readonly string[]).includes(roomId)) continue;
        if (meta.createdAt && now - meta.createdAt > EIGHT_HOURS) {
          delete st.rooms[roomId];
          deleted++;
        }
      }
      await saveState(this.state.storage, st);
      return jsonResponse({ ok: true, deleted, remaining: Object.keys(st.rooms).length });
    }

    return jsonResponse({ error: 'Not Found' }, { status: 404 });
  }
}


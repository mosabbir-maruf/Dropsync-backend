import type { Env } from '../env';
import { parseInbound } from '../protocol/parse';
import type { WsInbound, WsOutbound } from '../protocol/types';
import { jsonResponse } from '../util/http';

type ClientInfo = {
  roomId: string;
  id: string;
  displayName: string;
};

type RoomCallState = {
  participants: string[];
  rejectedUsers: string[];
  leftUsers: string[];
  initiator: string;
  type: 'audio' | 'video' | string;
};

type DurableState = {
  // roomId -> call state
  roomCalls: Record<string, RoomCallState>;
};

const STATE_KEY = 'state:v1';
const HARDCODED_ROOMS = ['retro-realm', 'sanctuary', 'lobby'] as const;

function randomIdHex(bytes: number) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function loadState(storage: DurableObjectStorage): Promise<DurableState> {
  const st = (await storage.get<DurableState>(STATE_KEY)) ?? { roomCalls: {} };
  if (!st.roomCalls) st.roomCalls = {};
  return st;
}

async function saveState(storage: DurableObjectStorage, st: DurableState) {
  await storage.put(STATE_KEY, st);
}

function wsSend(ws: WebSocket, msg: WsOutbound) {
  ws.send(JSON.stringify(msg));
}

export class RoomDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  // In-memory live sockets
  private rooms = new Map<string, Set<WebSocket>>(); // roomId -> sockets
  private clients = new Map<WebSocket, ClientInfo>(); // socket -> client info

  // userId -> active connection count (across rooms); helps avoid duplicate join/leave broadcasts
  private userConnCount = new Map<string, number>();

  // durable
  private durable: DurableState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async getDurable() {
    if (!this.durable) this.durable = await loadState(this.state.storage);
    return this.durable;
  }

  private getRoomPeers(roomId: string) {
    let s = this.rooms.get(roomId);
    if (!s) {
      s = new Set();
      this.rooms.set(roomId, s);
    }
    return s;
  }

  private broadcastToRoom(roomId: string, msg: WsOutbound, except?: WebSocket) {
    const peers = this.rooms.get(roomId);
    if (!peers) return;
    const payload = JSON.stringify(msg);
    for (const p of peers) {
      if (p !== except) {
        try {
          p.send(payload);
        } catch {
          // ignore
        }
      }
    }
  }

  private broadcastLobbyUsers() {
    const lobbyPeers = this.rooms.get('lobby');
    if (!lobbyPeers) return;
    const users = Array.from(lobbyPeers)
      .map((peer) => this.clients.get(peer)?.id)
      .filter((id): id is string => !!id);
    const msg: WsOutbound = { type: 'lobby-users', users };
    const payload = JSON.stringify(msg);
    for (const peer of lobbyPeers) {
      try {
        peer.send(payload);
      } catch {}
    }
  }

  private broadcastRoomUsers(roomId: string) {
    const peers = this.rooms.get(roomId);
    if (!peers) return;
    const users = Array.from(peers)
      .map((peer) => this.clients.get(peer)?.id)
      .filter((id): id is string => !!id);
    const msg: WsOutbound = { type: 'room-users', users };
    this.broadcastToRoom(roomId, msg);
  }

  private broadcastAllUsers() {
    const allUsers = Array.from(this.clients.values()).map(({ id, roomId }) => ({ id, roomId }));
    const lobbyPeers = this.rooms.get('lobby');
    if (!lobbyPeers) return;
    const msg: WsOutbound = { type: 'all-users', users: allUsers };
    const payload = JSON.stringify(msg);
    for (const peer of lobbyPeers) {
      try {
        peer.send(payload);
      } catch {}
    }
  }

  private async fetchRegistry(path: string, payload: unknown) {
    const id = this.env.REGISTRY_DO.idFromName('registry');
    const stub = this.env.REGISTRY_DO.get(id);
    return stub.fetch(`https://registry${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  private async broadcastPublicRooms() {
    const res = await this.fetchRegistry('/get-public-rooms', {});
    const data = await res.json<any>();
    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    // attach live memberCount
    const enriched = rooms.map((r: any) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      description: String(r.description ?? ''),
      memberCount: this.rooms.get(String(r.id))?.size ?? 0,
      isPrivate: !!r.isPrivate,
      isSecure: !!r.isSecure
    }));

    const lobbyPeers = this.rooms.get('lobby');
    if (!lobbyPeers) return;
    const msg: WsOutbound = { type: 'public-rooms', rooms: enriched };
    const payload = JSON.stringify(msg);
    for (const peer of lobbyPeers) {
      try {
        peer.send(payload);
      } catch {}
    }
  }

  private bumpUserConn(userId: string, delta: number) {
    const cur = this.userConnCount.get(userId) ?? 0;
    const next = cur + delta;
    if (next <= 0) this.userConnCount.delete(userId);
    else this.userConnCount.set(userId, next);
    return next;
  }

  private async handleMessage(ws: WebSocket, msg: WsInbound) {
    switch (msg.type) {
      case 'create-room': {
        const { name, isPublic, passwordProtected, createdBy, description } = msg.payload ?? {};
        if (!name || !createdBy) return;
        const newRoomId = randomIdHex(6);
        let password: string | null = null;
        let passwordHash: string | null = null;
        let isSecure = false;
        if (passwordProtected) {
          // Match Node: random 8 chars
          password = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(6))))
            .replace(/[^a-zA-Z0-9]/g, '')
            .slice(0, 8);
          passwordHash = await sha256Hex(password);
          isSecure = true;
        }

        await this.fetchRegistry('/create-room', {
          id: newRoomId,
          name,
          isPublic: !!isPublic,
          passwordHash,
          createdBy,
          adminId: createdBy,
          description: description ?? '',
          isSecure,
          createdAt: Date.now()
        });

        wsSend(ws, { type: 'room-created', roomId: newRoomId, password });
        await this.broadcastPublicRooms();
        break;
      }
      case 'get-public-rooms': {
        await this.broadcastPublicRooms();
        break;
      }
      case 'join': {
        const roomId = msg.roomId;
        const userId = msg.userId;
        if (!roomId || !userId) return;

        // Validate password if registry knows the room and it's secure
        const isDirectChatRoom = roomId.includes('--');
        const isSystemRoom = (HARDCODED_ROOMS as readonly string[]).includes(roomId);

        const infoRes = await this.fetchRegistry('/get-room-info', { roomId });
        const info = await infoRes.json<any>();
        if (info?.exists) {
          const validateRes = await this.fetchRegistry('/validate-room-password', {
            roomId,
            password: (msg as any).password
          });
          const v = await validateRes.json<any>();
          if (v?.ok === false) {
            wsSend(ws, { type: 'join-error', error: v?.error || 'Incorrect password' });
            return;
          }
        } else {
          if (!isDirectChatRoom && !isSystemRoom) {
            wsSend(ws, { type: 'join-error', error: 'Room not found or requires password' });
            return;
          }
        }

        const peers = this.getRoomPeers(roomId);

        // detect duplicate join (same userId already present in room with another socket)
        let userAlreadyInRoom = false;
        for (const [existingWs, ci] of this.clients.entries()) {
          if (existingWs !== ws && ci.id === userId && ci.roomId === roomId && peers.has(existingWs)) {
            userAlreadyInRoom = true;
            break;
          }
        }

        peers.add(ws);
        const displayName = (msg as any).displayName || userId;
        this.clients.set(ws, { roomId, id: userId, displayName });
        this.bumpUserConn(userId, 1);

        if (!userAlreadyInRoom) {
          this.broadcastToRoom(roomId, { type: 'user-joined', userId, displayName }, ws);
        }

        this.broadcastRoomUsers(roomId);
        if (roomId === 'lobby') this.broadcastLobbyUsers();
        this.broadcastAllUsers();
        await this.broadcastPublicRooms();
        break;
      }
      case 'signal': {
        const { roomId, userId, targetId, signal } = msg as any;
        if (!roomId || !userId || !targetId || signal == null) return;
        const peers = this.rooms.get(roomId);
        if (!peers) return;
        const out: WsOutbound = { type: 'signal', from: userId, signal };
        for (const peer of peers) {
          if (this.clients.get(peer)?.id === targetId) {
            wsSend(peer, out);
          }
        }
        break;
      }
      case 'chat-invite': {
        const { roomId, userId, targetId } = msg as any;
        if (!roomId || !userId || !targetId) return;
        const peers = this.rooms.get('lobby');
        if (!peers) return;
        const out: WsOutbound = { type: 'chat-invite', from: userId, roomId };
        for (const peer of peers) {
          if (this.clients.get(peer)?.id === targetId) wsSend(peer, out);
        }
        break;
      }
      case 'call': {
        const { roomId, userId, targetId, callType } = msg as any;
        if (!roomId || !userId || !targetId || !callType) return;
        const peers = this.rooms.get(roomId);
        if (!peers) return;
        const out: WsOutbound = { type: 'call', callType: String(callType), from: userId, roomId };
        for (const peer of peers) {
          if (this.clients.get(peer)?.id === targetId) wsSend(peer, out);
        }
        break;
      }
      case 'call-accepted':
      case 'call-missed':
      case 'call-rejected': {
        const { roomId, targetId, from } = msg as any;
        if (!roomId || !targetId || !from) return;
        const peers = this.rooms.get(roomId);
        if (!peers) return;
        const out: WsOutbound = { type: msg.type as any, from: String(from), roomId };
        for (const peer of peers) {
          if (this.clients.get(peer)?.id === targetId) wsSend(peer, out);
        }
        break;
      }
      case 'room-call':
      case 'room-call-accepted':
      case 'room-call-rejected':
      case 'room-call-end':
      case 'room-call-join': {
        const roomId = (msg as any).roomId;
        const userId = (msg as any).userId;
        if (!roomId || !userId) return;
        const durable = await this.getDurable();
        const callKey = roomId;
        const existing = durable.roomCalls[callKey];

        const ensure = () => {
          if (!durable.roomCalls[callKey]) {
            durable.roomCalls[callKey] = {
              participants: [userId],
              rejectedUsers: [],
              leftUsers: [],
              initiator: userId,
              type: String((msg as any).callType || 'audio')
            };
          }
          return durable.roomCalls[callKey]!;
        };

        const call = ensure();

        const addUnique = (arr: string[], v: string) => {
          if (!arr.includes(v)) arr.push(v);
        };
        const remove = (arr: string[], v: string) => {
          const i = arr.indexOf(v);
          if (i >= 0) arr.splice(i, 1);
        };

        if (msg.type === 'room-call') {
          addUnique(call.participants, userId);
          remove(call.rejectedUsers, userId);
          remove(call.leftUsers, userId);
          call.type = String((msg as any).callType || call.type);
        } else if (msg.type === 'room-call-accepted') {
          addUnique(call.participants, userId);
          remove(call.rejectedUsers, userId);
          remove(call.leftUsers, userId);
        } else if (msg.type === 'room-call-join') {
          addUnique(call.participants, userId);
          remove(call.rejectedUsers, userId);
          remove(call.leftUsers, userId);
        } else if (msg.type === 'room-call-end') {
          remove(call.participants, userId);
          addUnique(call.leftUsers, userId);
        } else if (msg.type === 'room-call-rejected') {
          remove(call.participants, userId);
          addUnique(call.rejectedUsers, userId);
        }

        const shouldEnd =
          msg.type === 'room-call-rejected'
            ? call.initiator === userId || call.participants.length === 0
            : msg.type === 'room-call-end'
              ? call.participants.length === 0
              : false;

        if (shouldEnd) {
          delete durable.roomCalls[callKey];
          await saveState(this.state.storage, durable);
          this.broadcastToRoom(roomId, {
            type: 'room-call-end',
            from: userId,
            roomId,
            participants: [],
            rejectedUsers: [],
            leftUsers: []
          });
          break;
        }

        await saveState(this.state.storage, durable);

        const out: WsOutbound =
          msg.type === 'room-call'
            ? {
                type: 'room-call',
                callType: String((msg as any).callType || call.type),
                from: userId,
                roomId,
                participants: [...call.participants],
                rejectedUsers: [...call.rejectedUsers],
                leftUsers: [...call.leftUsers]
              }
            : {
                type: msg.type as any,
                from: userId,
                roomId,
                participants: [...call.participants],
                rejectedUsers: [...call.rejectedUsers],
                leftUsers: [...call.leftUsers]
              };

        this.broadcastToRoom(roomId, out);
        break;
      }
      case 'kick': {
        const { roomId, userId, targetId } = msg as any;
        if (!roomId || !userId || !targetId) return;

        const metaRes = await this.fetchRegistry('/get-room-meta', { roomId });
        const meta = await metaRes.json<any>();
        if (!meta?.exists) return;
        if (meta.adminId !== userId) return;

        const peers = this.rooms.get(roomId);
        if (!peers) return;

        for (const peer of peers) {
          if (this.clients.get(peer)?.id === targetId) {
            peers.delete(peer);
            this.clients.delete(peer);
            this.bumpUserConn(targetId, -1);
            try {
              wsSend(peer, { type: 'kicked', roomId });
              peer.close(1000, 'kicked');
            } catch {}
            this.broadcastToRoom(roomId, { type: 'user-kicked', userId: targetId }, peer);
            break;
          }
        }
        this.broadcastRoomUsers(roomId);
        await this.broadcastPublicRooms();
        break;
      }
      case 'leave': {
        const { roomId, userId } = msg as any;
        if (!roomId || !userId) return;
        await this.leaveInternal(ws, roomId, userId);
        break;
      }
      case 'get-room-info': {
        const targetRoomId = msg.payload?.roomId || (msg as any).roomId;
        if (!targetRoomId) {
          wsSend(ws, { type: 'room-info-error', error: 'Room ID required' });
          return;
        }
        const res = await this.fetchRegistry('/get-room-info', { roomId: targetRoomId });
        const info = await res.json<any>();
        if (info?.error) {
          wsSend(ws, { type: 'room-info-error', error: String(info.error) });
          return;
        }
        wsSend(ws, {
          type: 'room-info',
          roomId: targetRoomId,
          name: String(info.name ?? `Room ${targetRoomId}`),
          isSecure: !!info.isSecure,
          isPrivate: !!info.isPrivate,
          description: String(info.description ?? ''),
          exists: !!info.exists
        });
        break;
      }
      case 'get-room-meta': {
        const roomId = msg.payload?.roomId || (msg as any).roomId;
        if (!roomId) return;
        const res = await this.fetchRegistry('/get-room-meta', { roomId });
        const meta = await res.json<any>();
        wsSend(ws, {
          type: 'room-meta',
          roomId,
          name: String(meta?.name ?? `Room ${roomId}`),
          adminId: meta?.adminId ?? undefined
        });
        break;
      }
      default:
        break;
    }
  }

  private async leaveInternal(ws: WebSocket, roomId: string, userId: string) {
    const peers = this.rooms.get(roomId);
    if (peers && peers.has(ws)) {
      peers.delete(ws);
      const clientInfo = this.clients.get(ws);
      const displayName = clientInfo?.displayName || userId;
      this.clients.delete(ws);
      const remaining = this.bumpUserConn(userId, -1);

      // match Node behavior: only broadcast user-left if user has no other connections
      if (remaining <= 0) {
        this.broadcastToRoom(roomId, { type: 'user-left', userId, displayName }, ws);
      }

      // admin transfer if needed
      const metaRes = await this.fetchRegistry('/get-room-meta', { roomId });
      const meta = await metaRes.json<any>();
      if (meta?.exists && meta.adminId === userId) {
        const roomPeers = this.rooms.get(roomId);
        let newAdminId: string | null = null;
        if (roomPeers && roomPeers.size > 0) {
          for (const p of roomPeers) {
            const info = this.clients.get(p);
            if (info && info.id !== userId) {
              newAdminId = info.id;
              break;
            }
          }
        }
        if (newAdminId) {
          await this.fetchRegistry('/set-admin', { roomId, adminId: newAdminId });
          this.broadcastToRoom(roomId, { type: 'admin-changed', newAdminId });
        }
      }

      if (peers.size === 0) this.rooms.delete(roomId);
    }

    this.broadcastRoomUsers(roomId);
    if (roomId === 'lobby') this.broadcastLobbyUsers();
    this.broadcastAllUsers();
    await this.broadcastPublicRooms();
  }

  private async acceptWebSocket(req: Request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();

    server.addEventListener('message', (evt) => {
      const data = typeof evt.data === 'string' ? evt.data : '';
      const msg = parseInbound(data);
      if (!msg) return;
      // serialize handler to DO event loop
      this.state.waitUntil(this.handleMessage(server, msg));
    });

    server.addEventListener('close', () => {
      const info = this.clients.get(server);
      if (!info) return;
      this.state.waitUntil(this.leaveInternal(server, info.roomId, info.id));
    });

    server.addEventListener('error', () => {
      const info = this.clients.get(server);
      if (!info) return;
      this.state.waitUntil(this.leaveInternal(server, info.roomId, info.id));
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      return this.acceptWebSocket(req);
    }
    if (req.method === 'POST' && url.pathname === '/init') {
      // Ensure registry defaults exist
      await this.fetchRegistry('/init-defaults', {});
      return jsonResponse({ ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      const rooms = Array.from(this.rooms.entries()).map(([id, set]) => ({ roomId: id, connections: set.size }));
      const totalWs = Array.from(this.rooms.values()).reduce((a, s) => a + s.size, 0);
      return jsonResponse({
        websocket: totalWs,
        rooms: rooms.length,
        clients: this.clients.size,
        roomStats: rooms
      });
    }
    return jsonResponse({ error: 'Not Found' }, { status: 404 });
  }
}


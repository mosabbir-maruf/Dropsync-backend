# DropSync Backend (Cloudflare Workers)

This is a Cloudflare-native replacement for the Node backend in `Backend/`:

- WebSocket signaling server (rooms, calls, invites, room-call)
- HTTP endpoints: `GET /`, `GET /health`, `GET /ping`
- Scheduled cleanup: cron every 10 minutes deletes rooms older than 8 hours (except `retro-realm`, `sanctuary`, `lobby`)

## Architecture (high level)

- **Worker**: handles HTTP + upgrades WebSocket requests.
- **Durable Object `RoomDO`**: a single **hub** instance (`idFromName('hub')`) that maintains live WebSocket sessions and in-memory room membership (this keeps compatibility with your current frontend that expects one WS connection to join/leave multiple rooms).
- **Durable Object `RegistryDO`**: durable room metadata (public/private, passwords, createdAt, adminId) + cleanup.
- **Files**: sent peer-to-peer over **WebRTC DataChannel** (no server storage).

## Setup

1. Install dependencies:

```bash
cd Backend-cloudflare
npm install
```

2. Run locally:

```bash
npm run dev
```

3. Deploy:

```bash
npm run deploy
```

## Frontend changes

- **WebSocket URL**: point to your Worker URL (same host as HTTP) using a normal WebSocket URL:
  - `wss://<your-worker-domain>`
  - The Worker forwards upgrades to the Durable Object.
- **File transfer**: use WebRTC **DataChannel** for P2P (no `/upload` endpoint).

## Notes

- CORS allowlist is in `src/util/cors.ts`.
- Room passwords are stored as SHA-256 hashes (same algorithm as the Node version).

## Cloudflare bindings (wrangler)

`wrangler.toml` includes:

- Durable Objects: `RoomDO`, `RegistryDO`
- Cron trigger: every 10 minutes (`*/10 * * * *`)

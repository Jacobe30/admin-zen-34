# Events Backend

Standalone Node/Express + Socket.IO service that stores events in SQLite and
broadcasts them to the admin dashboard in real time.

## Run locally

```bash
cd backend
cp .env.example .env      # optional, tweak as needed
npm install               # or: bun install / pnpm install
npm run dev               # starts on http://localhost:3001
```

## HTTP API

- `GET  /health` – liveness probe
- `POST /events` – ingest an event. Body: `{ "type": "signup", "source": "web", "payload": { ... } }`
- `GET  /events?limit=100` – list events, newest first
- `GET  /events/:id` – fetch one
- `DELETE /events/:id` – delete one (requires `Authorization: Bearer $ADMIN_TOKEN` if set)
- `DELETE /events` – clear all (same auth rule)

## Socket.IO

- Client emits `join` with `{ role: "admin" }` to receive broadcasts.
- Server emits:
  - `event:new` – payload is the new event
  - `event:deleted` – `{ id }`
  - `event:cleared` – `{}`
- Clients may also push events via `event:push` with the same body as `POST /events` (optional ack callback).

## Connecting the dashboard

Point the frontend at this service by setting in the project root `.env`:

```
VITE_BACKEND_WS_URL=http://localhost:3001
```

Then in your dashboard code:

```ts
import { getSocket } from "@/lib/backend";
const socket = getSocket();          // already joins as admin
socket.on("event:new", (ev) => { /* update UI */ });
```

Fetch history with `fetch(`${RAILWAY_BASE}/events`)`.

## Deploy

Any Node 20+ host works (Railway, Render, Fly, a VPS). Set env vars from
`.env.example` and mount a persistent volume at `DB_PATH` so events survive
restarts. Start command: `npm start`.

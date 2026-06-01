# Synapse — a real-time collaborative whiteboard

Open a board, share the link, and draw together. Synapse is an infinite canvas you can sketch on with other people in real time — their strokes and cursors show up as they happen, and the board is still there when you come back.

It started life as a weekend prototype and has since grown into a properly production-shaped app: durable history in PostgreSQL, horizontal scaling through Redis, authenticated rooms, rate limiting, health checks, metrics, and a test suite that actually means something.

[![CI](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF?logo=githubactions&logoColor=white)](.github/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React%2019-61dafb?logo=react&logoColor=black)](https://react.dev/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-010101?logo=socketdotio&logoColor=white)](https://socket.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

---

## What it does

- **Draw together, live.** Freehand strokes broadcast to everyone in the room over WebSockets.
- **See each other.** Live cursors with names and a distinct color per person.
- **Infinite canvas.** Pan and zoom (0.05×–20×) across an unbounded space.
- **Pick up where you left off.** Strokes are persisted, so history survives a refresh — or a server restart.
- **Rooms by link.** Every board is its own room behind a short URL. Rooms can be password-protected.
- **Export your work.** Save the board as PNG or PDF.
- **Built to be used by anyone.** Keyboard-navigable, screen-reader friendly, responsive down to mobile, and it respects `prefers-reduced-motion`.

## How it's built

Synapse is a TypeScript monorepo with two apps:

```
.
├── client/      # React 19 + Vite + Tailwind v4 single-page app
├── server/      # Node + Express 5 + Socket.IO 4 real-time server
├── docker-compose.yml
└── .github/workflows/ci.yml
```

### The big picture

```
   Browser ──┐                         ┌── PostgreSQL  (durable stroke history)
   Browser ──┤  WebSocket / HTTPS      │
   Browser ──┼────────────▶  Synapse server(s)  ──────┤
   Browser ──┘                         │
                                       └── Redis  (cross-instance fan-out + presence)
```

Any server instance can serve any room. Room broadcasts fan out through a Redis adapter, so you can run several instances behind a load balancer and it just works. Drawing is broadcast immediately for low latency, while a write-behind buffer batches strokes to PostgreSQL in the background — durability without the per-stroke round trip.

### Server layout

The server is organized in clear layers so each piece has one job:

```
server/src/
├── index.ts          # composition root — wires everything together, owns startup/shutdown
├── app.ts            # Express app: CORS, health/readiness, join-token & metrics routes
├── socket/           # gateway, per-connection context, Redis adapter wiring
├── handlers/         # one file per socket event (join, draw, cursor, clear, resync, …)
├── services/         # Stroke_Service (ordering + buffering + compaction), Presence_Service
├── repositories/     # PostgreSQL data access (boards, strokes)
├── middleware/        # auth guard, token-bucket rate limiter
├── validation/       # zod schemas for every inbound payload
├── persistence/      # pg pool, Redis clients
├── observability/    # structured logging (pino), Prometheus metrics, health checks
└── config/           # validated environment loader
```

## Getting started

You'll need **Node.js 20+**. For the full experience (persistence + scaling) you'll also want **PostgreSQL** and **Redis** — the quickest way to get both is Docker.

### Option A — run everything with Docker

```bash
cp server/.env.example server/.env   # adjust values if you like
docker compose up --build
```

This starts PostgreSQL, Redis, and the server together. The server waits until both datastores are healthy before accepting connections.

### Option B — run the pieces yourself

**1. Start Postgres and Redis** (or point the env vars at your own).

**2. Server**

```bash
cd server
npm install
cp .env.example .env          # then fill in DATABASE_URL, REDIS_URL, JWT_SECRET, CLIENT_ORIGINS
npm run migrate               # create the database schema
npm run dev                   # http://localhost:3001
```

**3. Client** (in a second terminal)

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

Open http://localhost:5173, enter a name, create a board, and share the URL. To see collaboration in action, open the same board in a second tab.

> **Tip:** for a quick demo without setting up auth, set `OPEN_MODE=true` in `server/.env` to skip join-token verification.

## Configuration

Everything is configured through environment variables, and the server validates them at startup — if something's missing or malformed, it tells you exactly what and exits instead of failing later. See [`server/.env.example`](./server/.env.example) for the full annotated list. The essentials:

| Variable | Required | What it's for |
|---|---|---|
| `CLIENT_ORIGINS` | yes | Comma-separated allowlist of client origins (CORS + socket handshake) |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_URL` | yes | Redis connection string |
| `JWT_SECRET` | yes | Signing secret for room join tokens (≥32 chars) |
| `PORT` | no | Server port (default `3001`) |
| `NODE_ENV` | no | `production` enforces HTTPS/WSS-only connections |
| `OPEN_MODE` | no | `true` bypasses join-token auth — demos/local only |

On the client, set `VITE_SERVER_URL` at build time to point at your server (defaults to `http://localhost:3001`).

## How collaboration stays consistent

A few design decisions are worth calling out, because they're what make the real-time experience hold together:

- **Every stroke gets a sequence number.** The server assigns a gap-free, monotonically increasing `seq` per board. Clients apply strokes strictly in order.
- **Gaps trigger a resync.** If a client notices a missing `seq` (say, after a flaky connection), it asks the server to replay exactly what it missed — no duplicates, no holes.
- **History is compacted, not unbounded.** Once a board exceeds its stroke cap, older strokes fold into a snapshot baseline so memory and storage stay bounded without changing what a new joiner sees.
- **Presence is distributed.** Connected users and their cursor colors live in Redis, so presence is consistent across instances and stale entries expire on their own.

These behaviors aren't just hoped-for — they're pinned down by property-based tests (see below).

## Testing

The server and client both use [Vitest](https://vitest.dev/), with [fast-check](https://fast-check.dev/) for property-based tests that check correctness invariants across hundreds of generated inputs.

```bash
# Server
cd server
npm run test:unit          # validation, rate limiting, sequencing, presence, …
npm run test:property      # correctness properties (≥100 cases each)
npm run test:integration   # real socket flows against ephemeral datastores

# Client
cd client
npm run test:unit
npm run test:property
```

Property tests cover things like *sequence numbers are always gap-free*, *compaction never changes what you see*, *a resync always converges*, *cursor colors stay unique across instances*, and *coordinate transforms round-trip cleanly*.

CI runs all of this — type-checking, linting, and every suite (with Postgres and Redis service containers) — on each pull request, and gates merges on the results. See [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## Operating it

- `GET /healthz` — liveness; answers instantly regardless of datastore state.
- `GET /readyz` — readiness; reports `not_ready` (and names the culprit) when Postgres or Redis is unreachable, or when persistence writes are backing up.
- `GET /metrics` — Prometheus metrics (active connections, rooms, strokes/sec, errors), restricted to internal callers.
- Logs are structured JSON (pino) with connection/room correlation ids.
- The server shuts down gracefully on `SIGTERM`/`SIGINT`: it stops accepting connections, flushes buffered strokes, and releases datastore connections within a bounded window.

## Tech stack

**Client:** React 19, TypeScript, Vite, Tailwind CSS v4, React Router, Socket.IO client, Lucide icons, jsPDF.

**Server:** Node, Express 5, Socket.IO 4, TypeScript, PostgreSQL (`pg` + `node-pg-migrate`), Redis (`ioredis` + `@socket.io/redis-adapter`), zod, jsonwebtoken, bcryptjs, pino, prom-client.

**Tooling:** Vitest, fast-check, supertest, Docker, GitHub Actions.

## A note on the name

"Synapse" is just the product name — the app is a general-purpose collaborative whiteboard. Use it for brainstorming, teaching, diagramming, or doodling with friends.

## License

[MIT](./LICENSE) — do what you like, no warranty.

# Synapse — Real-time Collaborative Whiteboard

<div align="center">

![Synapse](https://img.shields.io/badge/Synapse-Collaborative%20Whiteboard-7c3aed?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0yMCAySDRjLTEuMSAwLTIgLjktMiAydjE2YzAgMS4xLjkgMiAyIDJoMTZjMS4xIDAgMi0uOSAyLTJWNGMwLTEuMS0uOS0yLTItMnptLTkgMTRINXYtMmg2djJ6bTQtNEg1di0yaDEwdjJ6bTAtNEg1VjZoMTB2MnoiLz48L3N2Zz4=)
[![React](https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-7-646cff?style=flat-square&logo=vite)](https://vitejs.dev/)
[![Socket.io](https://img.shields.io/badge/Socket.io-4-010101?style=flat-square&logo=socket.io)](https://socket.io/)
[![Express](https://img.shields.io/badge/Express-4-000000?style=flat-square&logo=express)](https://expressjs.com/)

**Draw together, in real time — anywhere.**

</div>

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Architecture](#architecture)
- [Canvas Engine](#canvas-engine)
- [Real-time Protocol](#real-time-protocol)
- [Environment Variables](#environment-variables)
- [Scripts Reference](#scripts-reference)
- [Known Limitations](#known-limitations)
- [License](#license)

---

## Overview

**Synapse** is a full-stack real-time collaborative whiteboard application. Multiple users can join the same board room, draw with freehand strokes, see each other's live cursors, and pan/zoom an infinite canvas — all with zero sign-up required.

Built with a Solo Leveling-inspired dark aesthetic: deep navy/black background, violet and indigo neon glows, animated particles, and a clean hunter-system UI.

---

## Features

| Feature | Description |
|---|---|
| **Real-time drawing** | Freehand strokes broadcast to all room members via WebSocket |
| **Live cursors** | Every user's cursor position is streamed to others with their name tag and unique color |
| **Infinite canvas** | Pan with `Alt + drag` or right-click drag; zoom with scroll wheel (0.05× – 20×) |
| **Room-based** | Each board is its own isolated room identified by a short URL ID |
| **Stroke history** | The server stores all strokes in memory; late-joining users receive the full history |
| **User presence** | Live sidebar shows all connected users with their cursor colors |
| **Clear board** | Clear the entire board and broadcast the clear event to all room members |
| **Persistent username** | Username is saved to `localStorage` so you don't have to re-enter it |
| **Recent boards** | The last 5 visited boards are saved locally for quick re-entry |
| **Color & brush** | Pick any stroke color and adjust brush width from the toolbar |

---

## Tech Stack

### Frontend (`client/`)

| Technology | Version | Role |
|---|---|---|
| **React** | 18 | UI framework (with StrictMode) |
| **TypeScript** | 5 | Type safety across all components and hooks |
| **Vite** | 7 | Dev server and build tool |
| **Tailwind CSS** | v4 | Utility-first styling (`@tailwindcss/vite` plugin) |
| **React Router DOM** | v6 | Client-side routing (`/` and `/board/:id`) |
| **Socket.io Client** | 4 | WebSocket connection to the server |
| **Lucide React** | latest | Icon library |
| **nanoid** | latest | Short unique ID generation for board rooms |

### Backend (`server/`)

| Technology | Version | Role |
|---|---|---|
| **Node.js** | 18+ | Runtime |
| **Express** | 4 | HTTP server |
| **Socket.io** | 4 | WebSocket server for real-time events |
| **TypeScript** | 5 | Typed server code |
| **ts-node** | latest | Run TypeScript directly without a build step |
| **cors** | latest | Cross-origin requests from the Vite dev server |

---

## Project Structure

```
Real-time-Shared-Whiteboard/
├── client/                          # Vite + React frontend
│   ├── public/
│   ├── src/
│   │   ├── hooks/
│   │   │   ├── useDraw.ts           # Canvas engine: sizing, DPR, pan/zoom, drawing
│   │   │   └── useSocket.ts         # Socket.io client: emit + receive events
│   │   ├── pages/
│   │   │   ├── Home.tsx             # Landing page with particle animation
│   │   │   └── Board.tsx            # Main whiteboard page + UI overlays
│   │   ├── App.tsx                  # Router: / → Home, /board/:id → Board
│   │   ├── main.tsx                 # React entry point (StrictMode)
│   │   └── index.css                # Tailwind base import
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
│
├── server/
│   ├── index.ts                     # Express + Socket.io server
│   ├── tsconfig.json
│   └── package.json
│
├── README.md
└── LICENSE
```

---

## Getting Started

### Prerequisites

- **Node.js** v18 or higher
- **npm** v9 or higher

### 1. Clone the repository

```bash
git clone <repo-url>
cd Real-time-Shared-Whiteboard
```

### 2. Install dependencies

Install both server and client dependencies:

```bash
# Server
cd server
npm install

# Client
cd ../client
npm install
```

### 3. Start the server

```bash
cd server
npm run dev
# Server starts on http://localhost:3001
```

### 4. Start the client

Open a **new terminal**:

```bash
cd client
npm run dev
# Client starts on http://localhost:5173
# (or 5174 if 5173 is occupied)
```

### 5. Open in browser

Navigate to **http://localhost:5173**, enter a name, and click **Create New Board**.

To test multi-user collaboration, open the same board URL in a second browser tab or window.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                     Browser (Tab 1)                  │
│                                                      │
│  ┌────────────┐    ┌──────────────┐                  │
│  │  Home.tsx  │    │  Board.tsx   │                  │
│  │  Landing   │───▶│  Whiteboard  │                  │
│  └────────────┘    └──────┬───────┘                  │
│                           │                          │
│              ┌────────────┴──────────────┐           │
│              │                           │           │
│         useDraw.ts                 useSocket.ts       │
│         Canvas engine              Socket.io client  │
│         - Sizing / DPR             - Emit strokes    │
│         - Pan / Zoom               - Emit cursors    │
│         - Draw strokes             - Recv remote     │
│         - Render loop              - User list       │
└──────────────────────────────────────────────────────┘
                           │ WebSocket
                           ▼
┌──────────────────────────────────────────────────────┐
│                   server/index.ts                    │
│                                                      │
│  Express HTTP server (port 3001)                     │
│  Socket.io server                                    │
│                                                      │
│  In-memory store:                                    │
│  rooms: Map<roomId, {                                │
│    strokes: Stroke[],                                │
│    users:   Map<socketId, User>,                     │
│    timeout: NodeJS.Timeout                           │
│  }>                                                  │
│                                                      │
│  Events handled:                                     │
│  join-room → send history, broadcast user list       │
│  draw       → store stroke, broadcast to room        │
│  cursor     → volatile broadcast (no store)          │
│  clear      → clear strokes, broadcast               │
│  disconnect → remove user, cleanup empty room        │
└──────────────────────────────────────────────────────┘
```

---

## Canvas Engine

The canvas system is implemented entirely in `client/src/hooks/useDraw.ts`.

### Coordinate System

All strokes are stored in **world space** (infinite coordinate space). The canvas applies a transform to convert between world space and screen space:

```
screen_x = (world_x + pan.x) * zoom
screen_y = (world_y + pan.y) * zoom
```

### DPR (Device Pixel Ratio) Handling

The canvas physical size is `cssWidth * devicePixelRatio` by `cssHeight * devicePixelRatio`. Every frame starts with:

```ts
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
```

This prevents blurry strokes on high-DPI (Retina) displays.

### Pan & Zoom

| Interaction | Action |
|---|---|
| `Alt + Left-click drag` | Pan the canvas |
| `Right-click drag` | Pan the canvas |
| `Scroll wheel` | Zoom in/out (clamped to 0.05× – 20×) |
| `Left-click drag` | Draw stroke |

Zoom is applied around the cursor position to maintain the point under the cursor.

### Render Pipeline

Each frame (triggered by state changes or RAF):

1. `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` — reset to CSS-pixel space
2. `ctx.fillRect(...)` — fill background `#09090f`
3. `ctx.save()` + `ctx.translate(pan.x * zoom, pan.y * zoom)` + `ctx.scale(zoom, zoom)` — enter world space
4. Draw dot grid (world-space aligned, density controlled)
5. Draw all strokes (past + current)
6. `ctx.restore()` — leave world space

---

## Real-time Protocol

Communication uses **Socket.io** events over WebSocket with automatic HTTP long-polling fallback.

### Client → Server Events

| Event | Payload | Description |
|---|---|---|
| `join-room` | `{ roomId, username }` | Join a board room |
| `draw` | `{ roomId, stroke: Stroke }` | Broadcast a completed stroke |
| `cursor` | `{ roomId, x, y, username }` | Broadcast cursor position (volatile) |
| `clear` | `{ roomId }` | Clear all strokes in the room |

### Server → Client Events

| Event | Payload | Description |
|---|---|---|
| `history` | `Stroke[]` | Full stroke history on join |
| `draw` | `Stroke` | A remote user's new stroke |
| `cursor` | `{ socketId, x, y, username, color }` | Remote cursor position |
| `user-left` | `socketId` | A user disconnected |
| `users` | `User[]` | Updated user list for the room |
| `clear` | — | Clears the canvas |

### Stroke Schema

```ts
interface Stroke {
  points: { x: number; y: number }[];  // World-space coordinates
  color: string;                        // CSS color string
  width: number;                        // Brush width in world units
}
```

### Cursor Color Assignment

The server maintains a pool of 20 distinct colors. Each user joining a room is assigned a unique color from the pool (cycling if the pool is exhausted).

---

## Environment Variables

The project uses hardcoded defaults for development. For production, configure:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server port |
| `VITE_SERVER_URL` | `http://localhost:3001` | WebSocket server URL (client-side) |

In `client/src/hooks/useSocket.ts`, the server URL is:

```ts
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";
```

Create a `client/.env` file for production:

```env
VITE_SERVER_URL=https://your-server-domain.com
```

---

## Scripts Reference

### Server (`server/`)

| Script | Command | Description |
|---|---|---|
| `dev` | `npx ts-node index.ts` | Start dev server with ts-node |
| `build` | `npx tsc` | Compile TypeScript to `dist/` |
| `start` | `node dist/index.js` | Run compiled production server |

### Client (`client/`)

| Script | Command | Description |
|---|---|---|
| `dev` | `vite` | Start Vite dev server with HMR |
| `build` | `tsc && vite build` | Type-check then bundle for production |
| `preview` | `vite preview` | Preview the production build locally |
| `typecheck` | `tsc --noEmit` | Type-check without emitting files |

---

## Known Limitations

- **In-memory storage only** — all strokes are lost when the server restarts. A future version could persist rooms to Redis or a database.
- **No authentication** — any user can join any board by knowing the room ID. Consider adding password-protected rooms for sensitive use cases.
- **Room cleanup** — empty rooms are deleted after 1 hour. Active rooms are never pruned.
- **No undo/redo** — stroke history is append-only. Undo would require a per-user command stack.
- **No text or shapes** — currently supports freehand drawing only. Text, rectangles, and ellipses could be added as additional stroke types.
- **No export** — canvas content cannot currently be exported to PNG or PDF.

---

## License

[MIT](./LICENSE) © 2026

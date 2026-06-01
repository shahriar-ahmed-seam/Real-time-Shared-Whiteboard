# Implementation Plan: Production Readiness — Synapse Collaborative Whiteboard

## Overview

This plan takes Synapse from prototype to production across the five phases defined in the design: (1) foundation and safety net (layered server structure, validated config, test harness), (2) protocol hardening (schema validation, rate limiting, auth, CORS, size caps), (3) durable persistence and horizontal scaling (PostgreSQL repositories, write-behind buffering, compaction, Redis adapter, distributed presence, reconnection resync), (4) client correctness and an accessible/responsive design system, and (5) deployment, observability, and CI/CD.

Implementation language is **TypeScript** for both the server (Node + Express 5 + Socket.IO 4) and the client (React 19 + Vite). Each task builds incrementally on the previous ones and ends by wiring new code into the running system, so the product stays shippable throughout. Test sub-tasks marked with `*` are optional and may be skipped for a faster MVP, but the property-based tests directly validate the correctness properties from the design and are strongly recommended.

## Tasks

- [x] 1. Establish layered server structure, validated configuration, and test harness
  - [x] 1.1 Restructure the server into the layered `server/src/` layout and compiled build
    - Split the current single `server/index.ts` into the directories from the design: `index.ts` (composition root), `app.ts` (Express app), `socket/`, `handlers/`, `validation/`, `middleware/`, `services/`, `repositories/`, `persistence/`, `config/`, `observability/`, `types/`
    - Update `server/tsconfig.json` to emit compiled JavaScript to `dist/` and add `build` and `start` npm scripts that run the compiled output (no `ts-node` at runtime)
    - Preserve current behavior so the prototype still runs after the move
    - _Requirements: 8.1_

  - [x] 1.2 Implement the validated environment Config_Loader
    - Create `config/env.ts` with a zod `EnvSchema` covering `NODE_ENV`, `PORT`, `CLIENT_ORIGINS`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `OPEN_MODE`, `STROKE_CAP`, `FLUSH_INTERVAL_MS`, `FLUSH_BATCH_SIZE`, `LOG_LEVEL`
    - Validate port range 1–65535, well-formed absolute URLs for origins/DB/Redis, and a `JWT_SECRET` of at least 32 characters; apply documented defaults for optional values
    - On failure, log one entry per invalid/missing variable (variable name + reason) and exit non-zero before binding the port; wire `loadEnv(process.env)` into `index.ts` so it runs before `server.listen`
    - _Requirements: 1.1, 1.2, 1.3, 1.5_

  - [x]* 1.3 Write unit tests for the Config_Loader
    - Test acceptance of valid env, rejection with per-variable errors for missing/invalid values, and application of defaults for optional variables
    - _Requirements: 1.2, 1.3, 1.5_

  - [x] 1.4 Create the example environment file
    - Add `.env.example` listing every variable with its purpose, required/optional status, and the default applied when optional
    - _Requirements: 1.4_

  - [x] 1.5 Set up the Vitest + fast-check test harness for server and client
    - Add Vitest config and scripts to both `server` and `client` packages; add `fast-check` for property tests and `supertest` + `socket.io-client` for server integration tests
    - Configure separate test scripts (unit, property, integration) runnable with a single-execution `--run` flag
    - _Requirements: 9.1, 9.2_

  - [x] 1.6 Define shared domain types
    - Create `types/domain.ts` with `StrokeSegment`, `PersistedStroke` (`id`, `seq`, `userId`, `ts`), `User`, and `BoardSnapshot`
    - _Requirements: 3.1, 5.1_

- [x] 2. Harden the real-time protocol (validation, rate limiting, auth, transport)
  - [x] 2.1 Implement zod socket payload schemas
    - Create `validation/schemas.ts` with `StrokeSegmentSchema`, `JoinRoomSchema`, `DrawSchema`, `CursorMoveSchema`, `ClearSchema` (strict), including coordinate, color, width, username, and roomId bounds; export inferred types
    - Provide a `safeParse`-based parse helper that returns a success/failure result and never throws
    - _Requirements: 2.2, 2.6_

  - [x]* 2.2 Write property test for validation totality
    - **Property 6: Validation totality** — every schema returns Ok or Err and never throws on arbitrary/adversarial JSON
    - **Validates: Requirements 2.2**
    - Run at least 100 generated inputs per schema

  - [x]* 2.3 Write unit tests for schema accept/reject and size bounds
    - Test valid payloads pass and malformed payloads (bad color, NaN/Infinity coords, oversized fields, control chars in username) are rejected
    - _Requirements: 2.2, 2.6_

  - [x] 2.4 Implement the token-bucket Rate_Limiter
    - Create `middleware/rateLimiter.ts` implementing `tryConsume` per the design pseudocode; configure `draw` (capacity 120, refill 120/s) and `cursor-move` (capacity 60, refill 60/s) buckets per socket per event
    - Keep tokens within `[0, capacity]`; drop on empty bucket without throwing
    - _Requirements: 2.3, 2.4, 2.9_

  - [x]* 2.5 Write property test for the rate-limit bound
    - **Property 5: Rate-limit bound** — allowed events in any window `w` never exceed `capacity + refillPerSec·w`, and `0 ≤ tokens ≤ capacity`
    - **Validates: Requirements 2.3**
    - Run at least 100 generated arrival patterns

  - [x]* 2.6 Write unit tests for rate-limiter token math
    - Test refill over elapsed time, draw vs cursor capacities, and drop-when-empty behavior
    - _Requirements: 2.3, 2.9_

  - [x] 2.7 Implement the Auth_Guard and Join_Token verification
    - Create `middleware/authGuard.ts` that verifies a signed, unexpired, room-scoped join token (using `JWT_SECRET`) and returns `{ ok: true, userId }` or `{ ok: false, code }` without throwing
    - Honor `OPEN_MODE` to bypass verification for demos
    - _Requirements: 2.1, 2.10_

  - [x]* 2.8 Write property test for authorization soundness
    - **Property 8: Authorization soundness** — an event is authorized only if its token is signature-valid and scoped to the referenced room, or `OPEN_MODE` is set
    - **Validates: Requirements 2.1**
    - Run at least 100 generated token/room combinations

  - [x]* 2.9 Write unit tests for the Auth_Guard
    - Test missing/invalid-signature/expired/wrong-scope tokens return failure codes, valid tokens succeed, and `OPEN_MODE` bypasses
    - _Requirements: 2.1, 2.10_

  - [x] 2.10 Implement the join-token HTTP endpoint with optional room password
    - Add `POST /api/rooms/:id/join` in `app.ts` that validates an optional password against the stored hash and issues a short-lived room-scoped JWT; deny with an incorrect-password error indication on mismatch
    - Rate-limit the endpoint
    - _Requirements: 2.7_

  - [x] 2.11 Configure CORS allowlist, payload size cap, and secure transport
    - Configure Express CORS and the Socket.IO handshake to accept only origins in the validated allowlist
    - Set `maxHttpBufferSize` to the configured max message size (default 16 KB) and return an invalid-payload error on oversized messages, leaving board state unchanged
    - Enforce HTTPS/WSS-only acceptance when `NODE_ENV=production`
    - _Requirements: 2.5, 2.6, 2.8_

- [x] 3. Checkpoint - protocol hardening
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement durable persistence and the Stroke_Service
  - [x] 4.1 Create the PostgreSQL schema, migrations, and connection pool
    - Add `boards` and `strokes` tables and the `idx_strokes_board_seq` index via a migration tool (e.g. `node-pg-migrate`); create `persistence/db.ts` exposing a `pg` pool built from `DATABASE_URL`
    - _Requirements: 3.6_

  - [x] 4.2 Implement the BoardRepository
    - Create `repositories/boardRepository.ts` implementing `ensure`, `getSnapshotSeq`, `setSnapshot`, `getPasswordHash`, `touch`
    - _Requirements: 2.7, 3.6_

  - [x] 4.3 Implement the StrokeRepository
    - Create `repositories/strokeRepository.ts` implementing `insertBatch` (multi-row insert), `loadSince`, `deleteThrough` (batched), `count`
    - _Requirements: 3.1, 3.6_

  - [x] 4.4 Implement Stroke_Service append with Sequence_Number assignment and write-behind buffering
    - Create `services/strokeService.ts` `append` that assigns a gap-free monotonic `seq` per board, returns the enriched `PersistedStroke`, buffers it in memory, and flushes batches by size or within `FLUSH_INTERVAL_MS`
    - Add `loadForJoin` (snapshot + tail) and `flush`
    - _Requirements: 3.1, 3.2_

  - [x]* 4.5 Write property test for Sequence_Number monotonicity
    - **Property 1: Sequence monotonicity** — for any sequence of `append` calls, emitted `seq` values are strictly increasing and gap-free
    - **Validates: Requirements 3.1**
    - Run at least 100 generated append sequences

  - [x]* 4.6 Write unit tests for seq assignment and buffer flushing
    - Test seq starts one past the baseline, flush triggers by batch size and by timer, and that accepted strokes reach the (mocked) repository
    - **Property 2: No stroke loss before flush boundary** is exercised here for the graceful path
    - _Requirements: 3.1, 3.2_

  - [x] 4.7 Implement board compaction (maybeCompact)
    - Add `maybeCompact` to `services/strokeService.ts` per the design pseudocode: when retained count exceeds STROKE_CAP, advance `snapshot_seq` to a cut point, delete redundant strokes in bounded batches, rebuild the hot tail, and return retained count to `<= STROKE_CAP`
    - _Requirements: 3.3_

  - [x]* 4.8 Write property test for compaction visual invariance
    - **Property 3: Compaction visual invariance** — for any stroke log and cap, the canvas from snapshot + retained tail equals the canvas from the full log, and retained count `<= STROKE_CAP`
    - **Validates: Requirements 3.3**
    - Run at least 100 generated logs and caps

  - [x] 4.9 Implement Persistence_Store write retry and persistence-ack handling
    - Wrap `insertBatch` flushes with up to 5 retries using exponential backoff bounded 1–30s; on exhaustion, retain buffered strokes, withhold the durable-persistence acknowledgment, and expose a flag the readiness check can read
    - _Requirements: 7.2, 7.6_

  - [x] 4.10 Implement board history restore on restart with failure handling
    - On first access after restart, restore a board's persisted history from the Persistence_Store before serving content; if restore fails, do not serve partial history, retain the data, and surface an error indication
    - _Requirements: 3.6, 3.9_

- [x] 5. Implement horizontal scaling and distributed presence
  - [x] 5.1 Set up the Redis client and Socket.IO Redis adapter
    - Create `persistence/redis.ts` and `socket/` adapter wiring so room broadcasts fan out across instances and any instance can serve any room without instance-local board state
    - _Requirements: 5.2, 5.3_

  - [x] 5.2 Implement the Redis-backed Presence_Service with atomic color allocation
    - Create `services/presenceService.ts` implementing `join`, `leave`, `updateCursor`, `list`, and `allocateColor`, storing `room:{id}:users` and `room:{id}:colors` in Redis; allocate a distinct color from the 20-color pool atomically across nodes (no guarantee beyond pool size)
    - _Requirements: 5.1, 5.5_

  - [x]* 5.3 Write property test for cursor color uniqueness across nodes
    - **Property 9: Color uniqueness across nodes** — for any room with `n ≤ 20` present users, assigned colors are distinct even across simulated nodes
    - **Validates: Requirements 5.1**
    - Run at least 100 generated join orderings

  - [x]* 5.4 Write unit tests for color allocation
    - Test distinct allocation up to pool size and graceful behavior at/over pool capacity
    - _Requirements: 5.1, 5.5_

  - [x] 5.5 Implement presence TTL expiry and stale-member broadcast
    - Add a TTL (≤30s) refreshed on activity to presence entries so an unclean disconnect expires; when a stale entry is removed, broadcast the updated member list to remaining members
    - _Requirements: 5.4, 5.6_

- [x] 6. Wire the hardened real-time protocol (gateway and handlers)
  - [x] 6.1 Implement the socket gateway and per-connection context
    - Create `socket/gateway.ts` and `socket/context.ts`: attach the Redis adapter, run the Auth_Guard on handshake, build per-connection rate limiters and auth/room context, and register handlers
    - _Requirements: 2.1, 5.3_

  - [x] 6.2 Implement the join-room handler with snapshot + tail history
    - Create `handlers/joinRoom.ts` sending the baseline snapshot plus following strokes in ascending seq order; serve from the snapshot when a reconnecting client reports a seq below the compaction baseline
    - _Requirements: 3.5, 3.7, 3.8_

  - [x] 6.3 Implement the draw handler (validated, rate-limited, persisted, broadcast)
    - Create `handlers/draw.ts`: rate-limit, schema-validate, enforce own-room authorization, call `strokeService.append`, broadcast via the adapter, and trigger `maybeCompact`; drop and emit an invalid-payload/rate-limited error indication appropriately while keeping the connection open
    - _Requirements: 2.3, 2.4, 3.1, 5.2_

  - [x] 6.4 Implement the cursor-move, clear, and disconnecting handlers
    - Create `handlers/cursorMove.ts` (rate-limited, validated, volatile broadcast), `handlers/clear.ts` (authorized, persisted clear marker, broadcast), and `handlers/disconnecting.ts` (presence leave + member-list broadcast)
    - _Requirements: 2.9, 5.2, 5.4, 5.6_

  - [x] 6.5 Implement the reconnection resync handler
    - Create `handlers/resync.ts` implementing `onClientReconnect`: send full baseline + tail when `lastAppliedSeq < snapshotSeq`, otherwise emit only the ordered delta; discard a reported seq above the server's highest and resync from baseline
    - _Requirements: 3.4, 3.7, 3.8_

  - [x]* 6.6 Write property test for resync convergence
    - **Property 4: Resync convergence** — for any `lastAppliedSeq` and server log, after resync the client's highest applied seq equals the server's highest seq with no stroke applied twice
    - **Validates: Requirements 3.4**
    - Run at least 100 generated client/server states

  - [x]* 6.7 Write integration tests for socket flows
    - With ephemeral Postgres and Redis (testcontainers/pg-mem + ioredis-mock) and two `socket.io-client` instances, assert join→history, draw broadcast ordering, clear propagation, reconnection resync delta, and rate-limit flood dropping
    - _Requirements: 9.3_

- [x] 7. Checkpoint - persistence, scaling, and protocol wiring
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement reliability and fault tolerance
  - [x] 8.1 Implement the Graceful_Shutdown sequence
    - On SIGTERM/SIGINT in `index.ts`: stop accepting connections, flush buffered strokes, close sockets, and release DB/Redis connections within 30s; on timeout, force termination while retaining unflushed strokes in the write buffer for recovery
    - _Requirements: 7.1, 7.5, 3.2_

  - [x] 8.2 Implement per-event error isolation
    - Wrap handler dispatch in the gateway so an unhandled exception logs with connection/room correlation ids, discards the failed event, and keeps the process and other connections alive
    - _Requirements: 7.4_

  - [x] 8.3 Implement degraded readiness on datastore unavailability
    - When the Coordination_Store is unavailable, continue serving same-instance members and report not-ready; when Persistence_Store write retries are exhausted, report not-ready until recovery
    - _Requirements: 7.3, 7.6_

- [x] 9. Implement observability
  - [x] 9.1 Implement structured logging
    - Create `observability/logger.ts` using pino; emit JSON logs with timestamp, severity, event type, and connection/room correlation ids, including error context for error events; level driven by `LOG_LEVEL`
    - _Requirements: 6.1_

  - [x] 9.2 Implement the metrics endpoint with access restriction
    - Create `observability/metrics.ts` using prom-client and expose `/metrics` reporting active connections, active rooms, strokes/sec over a rolling 60s window, and cumulative error count; restrict access to internal addresses or authenticated callers and deny others with no metrics data
    - _Requirements: 6.2, 6.6, 6.7_

  - [x] 9.3 Implement liveness and readiness endpoints
    - Add `/healthz` responding success within 1s regardless of datastore reachability, and `/readyz` reporting ready only when DB and Redis connectivity checks both succeed within 5s, indicating which dependency failed otherwise
    - _Requirements: 6.3, 6.4, 6.5_

- [x] 10. Implement client canvas correctness and resilience
  - [x] 10.1 Extract pure coordinate transform helpers
    - Extract `screenToWorld`/`worldToScreen` (and zoom-around-cursor math) from `useDraw.ts` into a pure, testable module that holds round-trip accuracy within 0.01px for scales 0.05×–20×
    - _Requirements: 4.1_

  - [x]* 10.2 Write property test for coordinate round-trip
    - **Property 7: Coordinate round-trip** — `worldToScreen(screenToWorld(p, t), t) ≈ p` within tolerance for any point and transform in range
    - **Validates: Requirements 4.1**
    - Run at least 100 generated points and transforms

  - [x] 10.3 Implement client seq tracking, gap detection, and resync requests
    - In `useSocket.ts`, track highest applied seq; apply a stroke only when `seq = last + 1`, ignore `seq <= last`, and request a resync when `seq > last + 1` instead of applying out of order
    - _Requirements: 4.4, 4.5, 4.6_

  - [x]* 10.4 Write unit tests for client gap detection ordering
    - Test the apply/ignore/resync branches for in-order, duplicate/old, and gapped strokes
    - _Requirements: 4.4, 4.5, 4.6_

  - [x] 10.5 Add a React error boundary around the board view
    - Wrap the `Board` route in an error boundary that shows a recoverable failure message with a re-attempt control and keeps the UI responsive instead of a blank screen
    - _Requirements: 4.2_

  - [x] 10.6 Add the reconnection indicator
    - Show a non-blocking "Reconnecting…" indicator while the socket is disconnected without disabling/obscuring the canvas or controls, and remove it on reconnect
    - _Requirements: 4.3, 4.7_

- [x] 11. Build the accessible, responsive design system and refactor the UI
  - [x] 11.1 Define centralized design tokens
    - Add the `@theme` color/typography/spacing/radius/motion tokens to `client/src/index.css` (and CSS custom properties), with contrast-checked text/background pairs meeting AA
    - _Requirements: 10.1, 10.2_

  - [x] 11.2 Build the accessible UI component library
    - Create `client/src/components/ui/` with `Button`, `Input`, `Modal`, `Tooltip`, `Toolbar`/`ToolbarButton`, `Popover`, `Toast`, each consuming tokens only (no hardcoded styles) with built-in focus rings, ARIA labels/roles, 44px targets, focus trap/restore, and text alternatives
    - _Requirements: 10.1, 10.3, 10.6, 10.7_

  - [x] 11.3 Refactor Home and Board to consume tokens/components and neutralize brand voice
    - Replace inline-styled elements in `Home.tsx`/`Board.tsx` with the `ui/` components and tokens (no inline/hardcoded style literals); update game-specific copy to neutral wording while keeping the visual identity
    - _Requirements: 10.1, 10.7_

  - [x] 11.4 Implement reduced-motion, keyboard navigation, and focus visibility
    - Honor `prefers-reduced-motion` (suppress non-informative animations, skip the particle loop); ensure full keyboard operability with reading-order focus and no traps; show a visible focus indicator with ≥3:1 contrast
    - _Requirements: 10.3, 10.4, 10.6_

  - [x] 11.5 Implement the responsive and mobile layout
    - Add the <640px mobile-adapted layout (reflow with no horizontal scroll, no lost content/functionality, ≥44×44px primary touch targets) and the documented tablet/desktop breakpoints
    - _Requirements: 10.5_

  - [x]* 11.6 Write component accessibility unit tests
    - Test keyboard operability, focus management (modal trap/restore), and presence of ARIA labels/text alternatives for the `ui/` components
    - _Requirements: 10.3, 10.6, 10.7_

- [x] 12. Containerize and set up CI/CD
  - [x] 12.1 Create the server container image definition
    - Add a multi-stage `Dockerfile`: build stage compiles to `dist/` from a version-pinned base image installing deps deterministically from the committed lockfile; runtime stage runs compiled `dist/index.js` as a non-root user
    - _Requirements: 8.1, 8.2, 8.3_

  - [x] 12.2 Configure the client production static build
    - Ensure `vite build` produces self-contained static assets referenced by relative paths requiring no server runtime; inject `VITE_SERVER_URL` at build time
    - _Requirements: 8.4_

  - [x] 12.3 Create the docker-compose definition
    - Add `docker-compose.yml` starting the server, Postgres, and Redis, passing connection URLs to the server, and configuring it to accept connections only after both datastores are reachable
    - _Requirements: 8.5, 8.6_

  - [x] 12.4 Create the CI pipeline with merge gating
    - Add a CI workflow that on PR runs type checking, linting, and the unit, property-based, and integration suites (with pg/redis service containers); block merge if any gate fails or does not complete, and permit merge when all pass
    - _Requirements: 9.4, 9.5, 9.6_

- [x] 13. Final checkpoint - full production-readiness verification
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; the property-based tests validate the design's correctness properties and are recommended.
- Each task references specific requirement clauses for traceability, and property test tasks additionally cite the design property number.
- Property-based tests (Properties 1, 3, 4, 5, 6, 7, 8, 9) each run at least 100 generated inputs per run, satisfying Requirement 9.2; Property 2 (no stroke loss before flush) is exercised by the buffer-flush unit tests and integration tests.
- Checkpoints provide incremental validation points and are not part of the parallel dependency graph.
- Phases align with the design's implementation phasing so each phase leaves the product working and deployable.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.4", "1.5", "1.6", "10.1", "11.1", "12.2"] },
    { "id": 2, "tasks": ["1.3", "2.1", "2.4", "2.7", "2.11", "4.1", "5.1", "9.1", "10.2", "10.3", "10.5", "11.2", "12.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.5", "2.6", "2.8", "2.9", "4.2", "4.3", "5.2", "9.3", "10.4", "11.3", "11.6", "12.3"] },
    { "id": 4, "tasks": ["2.10", "4.4", "5.3", "5.4", "5.5", "6.1", "10.6"] },
    { "id": 5, "tasks": ["4.5", "4.6", "4.7", "6.2", "6.3", "6.4", "6.5", "8.1", "8.2", "9.2", "11.4"] },
    { "id": 6, "tasks": ["4.8", "4.9", "6.6", "6.7", "8.3", "11.5"] },
    { "id": 7, "tasks": ["4.10", "12.4"] }
  ]
}
```

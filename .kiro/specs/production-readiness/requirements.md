# Requirements Document

## Introduction

Synapse is a real-time collaborative whiteboard (Vite + React 19 + TypeScript client, Express 5 + Socket.IO 4 + TypeScript server). Today it works as a prototype: freehand drawing, live cursors, room-based presence, stroke history for late joiners, and an infinite pan/zoom canvas all function. However, all state lives in a single server process's in-memory `Map`, there is no authentication, no input validation, no rate limiting, no persistence, no horizontal scaling, no automated tests or CI, and only a trivial health route. A server restart loses every board.

This feature makes Synapse production-ready and market-ready across these areas: durable persistence, authentication and authorization for boards, security hardening (input validation, rate limiting, CORS, secure transport, payload bounds), horizontal scalability and bounded memory, reliability (graceful reconnection, error handling, graceful shutdown), observability (structured logging, metrics, health/readiness probes), configuration and deployment (validated environment config, containerization, CI/CD), automated quality gates, and an accessible, responsive UI built on a design system.

The existing architecture is preserved and hardened incrementally rather than rewritten, so the product stays shippable throughout.

### Scope Note

In scope: everything required to operate Synapse safely and reliably in production at scale, plus the accessibility and design-system work needed for the product to be market-ready.

Out of scope (called out per the request): new user-facing drawing capabilities such as undo/redo, text and shape primitives, and PNG/PDF export. These are feature gaps, not production-readiness concerns, and are excluded unless they directly intersect a production-readiness requirement (for example, a render error in an export path must be caught by the client error-handling requirements). Full multi-tenant user accounts with billing and CRDT/operational-transform conflict resolution are also out of scope for this iteration.

## Glossary

- **Synapse_Server**: The backend Node.js process (Express 5 + Socket.IO 4) that handles socket connections, room state, and persistence.
- **Synapse_Client**: The React single-page application that renders the whiteboard and connects to the Synapse_Server.
- **Synapse_Project**: The source repository containing both the client and server packages plus their build, deployment, and CI configuration.
- **Config_Loader**: The Synapse_Server component that loads and validates environment configuration at startup.
- **Schema_Validator**: The Synapse_Server component that parses inbound socket payloads against a defined schema.
- **Auth_Guard**: The Synapse_Server component that verifies a connection's join token before room events are processed.
- **Rate_Limiter**: The Synapse_Server component that bounds the rate of high-frequency events per connection using a token bucket.
- **Stroke_Service**: The Synapse_Server component that assigns stroke ordering, buffers writes, persists strokes, and compacts board history.
- **Presence_Service**: The Synapse_Server component that tracks connected users and cursor colors per room across server instances.
- **Persistence_Store**: The durable datastore (PostgreSQL) holding boards and strokes.
- **Coordination_Store**: The shared datastore (Redis) used for the Socket.IO adapter and presence.
- **CI_Pipeline**: The continuous-integration automation that runs type checks, linting, and tests on changes.
- **Join_Token**: A signed, short-lived, room-scoped credential the Synapse_Client presents to authorize socket events.
- **OPEN_MODE**: A configuration flag that, when enabled, bypasses Join_Token verification for demo or development use.
- **STROKE_CAP**: The configured maximum number of strokes retained in live form per board before compaction occurs.
- **FLUSH_INTERVAL_MS**: The configured maximum delay before buffered strokes are durably persisted.
- **Sequence_Number**: A monotonic, per-board ordering key assigned by the Stroke_Service to each persisted stroke.
- **Graceful_Shutdown**: An orderly process termination triggered by a termination signal, during which buffered work is flushed and connections are closed.

## Requirements

### Requirement 1: Validated Configuration and Environment Management

**User Story:** As an operator, I want all environment-specific settings to come from validated configuration, so that I can deploy Synapse to different environments without code changes and catch misconfiguration before traffic is served.

#### Acceptance Criteria

1. WHEN the Synapse_Server starts, THE Config_Loader SHALL read all environment-specific values (server port, allowed client origins, Persistence_Store URL, Coordination_Store URL, signing secret) from environment variables before the Synapse_Server binds to the server port.
2. WHEN the Config_Loader reads the environment-specific values, THE Config_Loader SHALL validate that the server port is an integer in the range 1 to 65535, that each allowed client origin, the Persistence_Store URL, and the Coordination_Store URL are well-formed absolute URLs, and that the signing secret is a non-empty string of at least 32 characters.
3. IF one or more required environment variables are missing or fail validation at startup, THEN THE Synapse_Server SHALL log one validation-failure entry per affected variable, each identifying the variable name and the reason for failure, and SHALL exit with a non-zero status code before binding to the server port and without accepting any client connections.
4. THE Synapse_Project SHALL include an example environment file that lists every configuration variable and, for each variable, documents its purpose, whether it is required or optional, and the default value applied when the variable is optional.
5. WHERE a configuration value is optional and the corresponding environment variable is not provided, THE Config_Loader SHALL apply the documented default value for that configuration value.

### Requirement 2: Security Hardening of the Real-time Protocol

**User Story:** As a board owner, I want every connection and message to be authenticated, validated, and rate-limited, so that malicious or malformed traffic cannot corrupt boards, exhaust resources, or access boards without permission.

#### Acceptance Criteria

1. WHERE OPEN_MODE is disabled, WHEN a room-scoped socket event is received, THE Synapse_Server SHALL process the event only when the connection presents a Join_Token whose signature is valid, whose expiry has not passed, and whose scope matches the referenced room.
2. WHEN any inbound socket payload is received, THE Schema_Validator SHALL parse the payload against its schema and return either a success result or a failure result without throwing an exception.
3. WHEN draw events arrive from a single connection, THE Rate_Limiter SHALL apply a token bucket of capacity 120 tokens refilling at 120 tokens per second, permitting at most `120 + (120 × window_seconds)` events within any time window of `window_seconds`, and SHALL keep its token count between 0 and 120 inclusive.
4. IF the Rate_Limiter token bucket for a connection is empty when an event arrives, THEN THE Synapse_Server SHALL drop the event without persisting it and without broadcasting it, and SHALL keep the connection open.
5. WHEN a cross-origin request or socket handshake arrives, THE Synapse_Server SHALL accept the connection only when the request origin is a member of the configured origin allowlist.
6. IF an inbound payload exceeds the configured maximum message size (default 16 kilobytes), THEN THE Synapse_Server SHALL reject the message, return an invalid-payload error indication to the sender, and leave board state unchanged.
7. WHERE a board is configured with a password, WHEN a client requests a Join_Token for that board, THE Synapse_Server SHALL issue a Join_Token only when the supplied password matches the stored password hash, and IF the supplied password does not match, THEN THE Synapse_Server SHALL deny the request and return an incorrect-password error indication.
8. WHILE running in production, THE Synapse_Server SHALL accept client connections only over encrypted transport (HTTPS and WSS).
9. WHEN cursor-move events arrive from a single connection, THE Rate_Limiter SHALL apply a token bucket of capacity 60 tokens refilling at 60 tokens per second, permitting at most `60 + (60 × window_seconds)` events within any time window of `window_seconds`, and SHALL keep its token count between 0 and 60 inclusive.
10. WHERE OPEN_MODE is disabled, IF a room-scoped socket event arrives on a connection whose Join_Token is absent, has an invalid signature, has expired, or has a scope that does not match the referenced room, THEN THE Synapse_Server SHALL reject the event, return an unauthorized error indication to the sender, and terminate the connection.
11. IF the Schema_Validator returns a failure result for an inbound payload, THEN THE Synapse_Server SHALL drop the event, return an invalid-payload error indication to the sender, and keep the connection open.

### Requirement 3: Durable Persistence and State Synchronization

**User Story:** As a user, I want board content to survive server restarts and stay correctly ordered, so that my drawings are not lost during deployments or crashes and late joiners see an accurate canvas.

#### Acceptance Criteria

1. WHEN the Stroke_Service appends a stroke to a board, THE Stroke_Service SHALL assign it a Sequence_Number exactly one greater than the previous stroke's Sequence_Number for that board, where the first stroke after a board baseline receives a Sequence_Number exactly one greater than the baseline's Sequence_Number, producing a consecutive sequence with no gaps.
2. WHEN the Stroke_Service accepts a valid stroke, THE Stroke_Service SHALL durably persist the stroke to the Persistence_Store within FLUSH_INTERVAL_MS or before completion of a Graceful_Shutdown.
3. WHILE a board's retained live stroke count exceeds STROKE_CAP, THE Stroke_Service SHALL compact the board so that the retained stroke count returns to at most STROKE_CAP while the canvas rendered from the compacted history remains identical to the canvas rendered from the full history.
4. WHEN a client reconnects and reports its highest applied Sequence_Number, THE Synapse_Server SHALL send every stroke with a Sequence_Number greater than the reported value in ascending Sequence_Number order, so that afterward the client's highest applied Sequence_Number equals the server's highest Sequence_Number for the board and no stroke is applied more than once.
5. WHEN a client joins a board, THE Synapse_Server SHALL send the current board state as a baseline snapshot plus the strokes following that snapshot in ascending Sequence_Number order.
6. WHEN the Synapse_Server restarts, THE Synapse_Server SHALL restore each board's persisted history from the Persistence_Store before serving that board's content to clients.
7. IF a reconnecting client reports a highest applied Sequence_Number below the board's current compaction baseline, THEN THE Synapse_Server SHALL send the baseline snapshot plus the strokes following it rather than the pruned strokes.
8. IF a reconnecting client reports a highest applied Sequence_Number greater than the server's highest Sequence_Number for the board, THEN THE Synapse_Server SHALL discard the reported value and resynchronize the client from the baseline snapshot.
9. IF restoring a board's persisted history from the Persistence_Store fails during restart, THEN THE Synapse_Server SHALL NOT serve partial history for that board, SHALL retain the persisted data, and SHALL return an error indication instead of an empty or partial canvas.

### Requirement 4: Client Canvas Correctness and Resilience

**User Story:** As a user, I want the canvas to render accurately and recover gracefully from errors and disconnects, so that drawing stays precise and a transient failure does not break my session.

#### Acceptance Criteria

1. WHEN the Synapse_Client converts a point from screen space to world space and back using the same pan-and-zoom transform at any zoom level within the supported range of 0.05× to 20×, THE Synapse_Client SHALL produce a point whose coordinates are within 0.01 pixels of the original point.
2. IF a rendering error occurs within the board view, THEN THE Synapse_Client SHALL display a failure message with a control to re-attempt rendering and SHALL remain responsive to user input instead of presenting an unresponsive blank screen.
3. WHILE the socket connection is lost, THE Synapse_Client SHALL display a reconnection indicator that does not disable or obscure the canvas and its controls.
4. IF the Synapse_Client receives a stroke whose Sequence_Number is greater than one past its highest applied Sequence_Number, THEN THE Synapse_Client SHALL request a resync from the Synapse_Server rather than applying the out-of-order stroke.
5. WHEN the Synapse_Client receives a stroke whose Sequence_Number is exactly one past its highest applied Sequence_Number, THE Synapse_Client SHALL apply the stroke and advance its highest applied Sequence_Number to that value.
6. IF the Synapse_Client receives a stroke whose Sequence_Number is less than or equal to its highest applied Sequence_Number, THEN THE Synapse_Client SHALL discard the stroke without re-applying it.
7. WHEN the socket connection is re-established, THE Synapse_Client SHALL remove the reconnection indicator.

### Requirement 5: Horizontal Scaling and Distributed Presence

**User Story:** As an operator, I want to run multiple server instances behind a load balancer, so that Synapse can scale with demand while real-time broadcasts and presence stay consistent across instances.

#### Acceptance Criteria

1. WHILE the number of users present in a room is at most the cursor color pool size of 20, WHEN a user joins that room, THE Presence_Service SHALL assign that user a cursor color distinct from every other user currently present in that room, even when those users are connected to different Synapse_Server instances.
2. WHEN a stroke, clear, or cursor event is broadcast to a room, THE Synapse_Server SHALL deliver the event through the Coordination_Store to every other member of the room regardless of which Synapse_Server instance each member is connected to.
3. WHERE more than one Synapse_Server instance is running, THE Synapse_Server SHALL allow any instance to serve any client for any room without instance-local board state.
4. WHEN a Synapse_Server instance stops serving a connection without a clean disconnect, THE Presence_Service SHALL expire that connection's presence entry after a time-to-live of at most 30 seconds so stale users are removed from the room.
5. IF the number of users present in a room reaches the cursor color pool size of 20, THEN THE Presence_Service SHALL NOT guarantee that an additional joining user receives a color distinct from all present users.
6. WHEN the Presence_Service removes a stale presence entry from a room, THE Synapse_Server SHALL send the updated room member list to the remaining members of that room.

### Requirement 6: Observability

**User Story:** As an operator, I want structured logs, metrics, and health probes, so that I can monitor Synapse, diagnose issues, and let orchestrators manage instances automatically.

#### Acceptance Criteria

1. WHEN connection, room, and error events occur, THE Synapse_Server SHALL emit structured logs that each include a timestamp, a severity level, an event type, and correlation identifiers for the connection and room, and that for error events additionally include the error context.
2. THE Synapse_Server SHALL expose a metrics endpoint reporting active connection count, active room count, stroke throughput measured as strokes per second over a rolling 60-second window, and a cumulative error count since process start.
3. WHILE the process is running, WHEN the liveness endpoint is probed, THE Synapse_Server SHALL respond with a success status within 1 second independently of whether the Persistence_Store and Coordination_Store are reachable.
4. WHEN the readiness endpoint is probed, THE Synapse_Server SHALL report ready only when a connectivity check to both the Persistence_Store and the Coordination_Store completes successfully within 5 seconds.
5. IF the readiness connectivity check to the Persistence_Store or the Coordination_Store does not complete successfully within 5 seconds, THEN THE Synapse_Server SHALL report not ready and indicate which dependency failed the check.
6. WHERE the metrics endpoint is exposed, THE Synapse_Server SHALL restrict access to callers from an internal network address or callers presenting valid authentication credentials.
7. IF a caller without an internal network address and without valid authentication credentials requests the metrics endpoint, THEN THE Synapse_Server SHALL deny the request and return no metrics data.

### Requirement 7: Reliability and Fault Tolerance

**User Story:** As a user, I want the service to handle failures and shutdowns gracefully, so that deployments and transient backend faults do not lose my work or crash my session.

#### Acceptance Criteria

1. WHEN the Synapse_Server receives a termination signal, THE Synapse_Server SHALL stop accepting new connections, flush buffered strokes to the Persistence_Store, close active socket connections, and release datastore connections, completing the sequence within 30 seconds before exiting.
2. IF a write to the Persistence_Store fails, THEN THE Stroke_Service SHALL retain the affected buffered strokes and retry the write up to 5 attempts using exponential backoff bounded between 1 and 30 seconds.
3. IF the Coordination_Store becomes unavailable, THEN THE Synapse_Server SHALL continue serving room members connected to the same instance and SHALL report a not-ready readiness state until the Coordination_Store is reachable again.
4. IF an unhandled exception occurs while processing a socket event, THEN THE Synapse_Server SHALL log the error with connection and room correlation identifiers, discard the failed event, and keep the process and other connections operating.
5. IF the Graceful_Shutdown sequence exceeds 30 seconds, THEN THE Synapse_Server SHALL force termination while retaining any unflushed strokes in the Persistence_Store write buffer for recovery on restart.
6. IF the Persistence_Store write retries are exhausted, THEN THE Stroke_Service SHALL preserve the buffered strokes, withhold the durable-persistence acknowledgment for those strokes, and the Synapse_Server SHALL report a not-ready readiness state.

### Requirement 8: Deployment and Containerization

**User Story:** As an operator, I want reproducible production builds and container images, so that I can deploy Synapse consistently across environments.

#### Acceptance Criteria

1. WHILE running in production, THE Synapse_Server SHALL execute from compiled JavaScript build output and SHALL NOT perform on-the-fly source compilation at startup.
2. THE Synapse_Project SHALL provide a container image definition that builds the Synapse_Server from a version-pinned base image and installs dependencies deterministically from the committed lockfile, so that two builds from the same commit produce functionally identical images.
3. WHEN the Synapse_Server container is run, THE container SHALL execute the Synapse_Server process as a non-root user.
4. WHEN the Synapse_Client is built for production, THE build process SHALL produce self-contained static files (HTML, JavaScript, CSS, and assets) that reference their assets by relative paths and require no server-side runtime to be served.
5. THE Synapse_Project SHALL provide a compose definition that starts the Synapse_Server, Persistence_Store, and Coordination_Store and configures the Synapse_Server with the connection URLs of the Persistence_Store and Coordination_Store.
6. WHEN the compose definition is started, THE Synapse_Server SHALL begin accepting connections only after the Persistence_Store and Coordination_Store are reachable.

### Requirement 9: Automated Testing and Continuous Integration

**User Story:** As a developer, I want automated tests and CI gates, so that regressions in correctness, security, and protocol behavior are caught before merge.

#### Acceptance Criteria

1. THE Synapse_Project SHALL include automated unit tests covering payload validation, rate-limiter token math, Sequence_Number assignment, and cursor color allocation.
2. THE Synapse_Project SHALL include property-based tests, each executing at least 100 randomly generated inputs per run, for Sequence_Number monotonicity, compaction visual invariance, resync convergence, rate-limit bounds, coordinate round-trip, and validation totality.
3. THE Synapse_Project SHALL include integration tests covering join-and-history, draw broadcast, clear propagation, reconnection resync, and rate limiting.
4. WHEN a pull request is opened or updated with a new commit, THE CI_Pipeline SHALL run type checking, linting, the unit test suite, the property-based test suite, and the integration test suite.
5. IF any CI gate fails or does not complete, THEN THE CI_Pipeline SHALL block merge of the pull request.
6. WHEN all CI gates pass, THE CI_Pipeline SHALL permit merge of the pull request.

### Requirement 10: Accessible, Responsive UI and Design System

**User Story:** As a user on any device, I want a consistent, accessible, responsive interface, so that I can use Synapse comfortably with a keyboard, on mobile, and with assistive technology.

#### Acceptance Criteria

1. THE Synapse_Client SHALL define its visual styling (color, typography, spacing, radius, motion) through centralized design tokens consumed by all components, with no inline or hardcoded style literals in components.
2. THE Synapse_Client SHALL provide a color contrast ratio of at least 4.5:1 for normal-size text and at least 3:1 for large-size text and the boundaries of interactive controls; full WCAG 2.1 AA conformance additionally requires manual verification with assistive technology.
3. THE Synapse_Client SHALL make every interactive control reachable and operable using only the keyboard, with a focus order that follows the reading order and with no keyboard trap.
4. WHERE the user has enabled a reduced-motion preference, THE Synapse_Client SHALL suppress non-informative animations and limit any residual motion to instantaneous or opacity-only changes.
5. WHILE displayed on a viewport narrower than 640 pixels, THE Synapse_Client SHALL present a mobile-adapted layout that reflows without horizontal scrolling, loses no content or functionality, and provides primary-control touch targets of at least 44 by 44 CSS pixels.
6. WHEN an interactive control receives keyboard focus, THE Synapse_Client SHALL display a visible focus indicator whose contrast against the adjacent background is at least 3:1.
7. THE Synapse_Client SHALL provide programmatically determinable text alternatives for interactive controls and for informative non-text elements.

import { defineConfig } from 'vitest/config';

/**
 * Vitest harness for the Synapse server.
 *
 * Three named projects separate the suites required by the design's Testing
 * Strategy so each can be run independently in a single pass (`vitest run`,
 * which is the non-watch / `--run` mode):
 *   - unit        → test/unit/**        (validation, rate-limiter math, seq, colors)
 *   - property    → test/property/**    (fast-check correctness properties)
 *   - integration → test/integration/** (supertest + socket.io-client flows)
 *
 * `passWithNoTests` keeps the harness green while suites are still being
 * authored by later tasks.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'property',
          environment: 'node',
          include: ['test/property/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          // Socket.IO + datastore flows need more headroom than unit tests.
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});

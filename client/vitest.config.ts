import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vitest harness for the Synapse client.
 *
 * Kept separate from `vite.config.ts` so the production build config stays
 * untouched. The React plugin is included here directly so component tests can
 * use JSX/TSX and React Fast Refresh transforms.
 *
 * Two named projects separate the suites:
 *   - unit     -> component/logic units (test/unit and co-located src tests)
 *   - property -> test/property (fast-check correctness properties)
 *
 * Component/unit tests run under jsdom; pure-logic property tests default to
 * the same DOM-capable environment, which is harmless for non-DOM code.
 *
 * `passWithNoTests` keeps the harness green while suites are still being
 * authored by later tasks.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    passWithNoTests: true,
    css: false,
    projects: [
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'unit',
          environment: 'jsdom',
          setupFiles: ['./test/setup.ts'],
          include: ['test/unit/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'property',
          environment: 'jsdom',
          setupFiles: ['./test/setup.ts'],
          include: ['test/property/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});

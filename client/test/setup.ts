// Global test setup for the client harness.
// Registers @testing-library/jest-dom matchers (toBeInTheDocument, etc.) and
// cleans up the DOM between tests so component suites stay isolated.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

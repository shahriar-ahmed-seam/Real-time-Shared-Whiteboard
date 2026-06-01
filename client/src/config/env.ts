// ─── Build-time configuration ────────────────────────────────────────
// Single, typed access point for the environment values Vite inlines at build
// time. Keeping this here (rather than reading `import.meta.env` ad hoc across
// the codebase) means the fallbacks and the contract live in exactly one place.

/**
 * Base URL of the Synapse server the client connects to over HTTP/WSS.
 *
 * Provided at build time via `VITE_SERVER_URL` (see `.env.example`). Falls back
 * to the local dev server when unset so `npm run dev` works with no config.
 */
export const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

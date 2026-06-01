/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the Synapse_Server (Socket.IO endpoint), injected at build time
   * by Vite from the `VITE_SERVER_URL` environment variable. When omitted the
   * client falls back to the local development server.
   */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

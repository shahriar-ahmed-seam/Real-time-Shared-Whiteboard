import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // Emit asset URLs as relative paths (e.g. "./assets/index-xxxx.js") so the
  // built static bundle is self-contained and can be served from any path/origin
  // (static host, CDN, sub-path) with no server-side runtime.
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    // Produce a self-contained static build under dist/.
    outDir: 'dist',
    assetsDir: 'assets',
    // Inline small assets as data URIs; larger ones are emitted under assets/
    // and referenced by relative paths thanks to `base: './'`.
    emptyOutDir: true,
  },
})

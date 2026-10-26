import { defineConfig } from "vite";

// The page is served by Vite on 5173; /api goes to api.mjs on 8788 (same origin for the browser, no CORS).
export default defineConfig({
  // @genclass/runtime loads its model in a Web Worker; Vite's code-splitting build needs ES-format workers
  worker: { format: "es" },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8788" },
  },
});

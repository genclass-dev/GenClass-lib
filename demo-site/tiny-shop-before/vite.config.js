import { defineConfig } from "vite";

// The page is served by Vite on 5173; /api goes to api.mjs on 8788 (same origin for the browser, no CORS).
// On Vercel the api/ folder serves the same routes as functions.
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8788" },
  },
});

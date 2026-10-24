import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { api } from './server/api'

// Mounts the in-memory backend (server/api.ts) into the dev and preview servers: no second process.
const backend = (): Plugin => ({
  name: 'rtk-5139-backend',
  configureServer: (server) => void server.middlewares.use(api),
  configurePreviewServer: (server) => void server.middlewares.use(api),
})

const rtk = JSON.parse(readFileSync(new URL('./node_modules/@reduxjs/toolkit/package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react(), backend()],
  define: { __RTK_VERSION__: JSON.stringify(rtk.version) },
  server: { port: 5173, strictPort: true },
})

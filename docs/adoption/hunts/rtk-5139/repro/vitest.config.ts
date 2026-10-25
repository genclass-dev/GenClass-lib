import { defineConfig } from 'vitest/config'

// Redux-only tests (node, no DOM, no React). The Playwright specs in e2e/ run with `npm run test:e2e`.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
})

import { defineConfig, devices } from '@playwright/test'

// One worker: the tests share the dev server's in-memory backend (each test resets it first).
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5173', ...devices['Desktop Chrome'] },
  webServer: { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000 },
})

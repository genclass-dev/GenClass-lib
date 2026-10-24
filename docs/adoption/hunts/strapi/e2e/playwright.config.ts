// Runs the Strapi-style spec in tests/e2e against a local Strapi (STRAPI_URL, default http://localhost:1337).
//   npx playwright test --config docs/adoption/hunts/strapi/e2e/playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e/tests',
  timeout: 90_000,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: process.env.STRAPI_URL ?? 'http://localhost:1337',
    headless: true,
    launchOptions: { args: ['--no-proxy-server'] },
  },
});

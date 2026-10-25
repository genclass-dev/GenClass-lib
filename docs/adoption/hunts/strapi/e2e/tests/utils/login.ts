// Stand-in for Strapi's tests/utils/login.ts, so the spec runs against a local Strapi outside the monorepo
// (docs/adoption/hunts/strapi.md). Same signature, same steps: the login form of a fresh browser context.
import type { Page } from '@playwright/test';

export const login = async ({ page }: { page: Page; rememberMe?: boolean }) => {
  await page.getByLabel(/email/i).fill(process.env.STRAPI_EMAIL ?? 'hunt@example.com');
  await page.getByLabel(/^password/i).fill(process.env.STRAPI_PASSWORD ?? 'HuntPassw0rd!');
  await page.getByRole('button', { name: /log ?in/i }).click();
  await page.waitForURL((u) => !/\/admin\/auth\//.test(u.pathname));
};

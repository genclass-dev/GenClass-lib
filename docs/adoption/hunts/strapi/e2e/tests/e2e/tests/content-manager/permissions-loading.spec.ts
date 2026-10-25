import { test, expect } from '@playwright/test';
import { login } from '../../../utils/login';
import { resetDatabaseAndImportDataFromPath } from '../../../utils/dts-import';

test.describe('Content Manager while the permissions are loading', () => {
  test.beforeEach(async ({ page }) => {
    await resetDatabaseAndImportDataFromPath('with-admin');
    await page.goto('/admin');
    await login({ page });
  });

  test('A collection type opened by its URL shows its list, not the 403 page, when the permissions answer last', async ({
    page,
  }) => {
    // Only the user's permissions are delayed, as on a slow network: they now arrive after the
    // content manager's own init and content-types-settings responses.
    await page.route('**/admin/users/me/permissions', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });

    await page.goto('/admin/content-manager/collection-types/api::article.article');

    await expect(page.getByRole('heading', { name: 'Article', exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/\/content-manager\/403/);
    await expect(
      page.getByText("You don't have the permissions to access that content")
    ).not.toBeVisible();
  });
});

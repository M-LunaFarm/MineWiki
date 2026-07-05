import { test, expect } from '@playwright/test';

test.describe('Landing page', () => {
  test('shows MineWiki Servers headline', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'MineWiki Servers Korea' })).toBeVisible();
  });
});

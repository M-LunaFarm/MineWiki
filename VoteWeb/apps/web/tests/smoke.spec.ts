import { test, expect } from '@playwright/test';

test.describe('Landing page', () => {
  test('shows CreeperVote headline', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'CreeperVote Korea' })).toBeVisible();
  });
});

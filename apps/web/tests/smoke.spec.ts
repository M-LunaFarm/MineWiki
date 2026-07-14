import { test, expect } from '@playwright/test';

test.describe('Landing page', () => {
  test('opens the server directory without a promotional headline', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('searchbox').first()).toBeVisible();
    await expect(page.getByRole('combobox', { name: '서버 정렬' })).toContainText('동접순');
  });
});

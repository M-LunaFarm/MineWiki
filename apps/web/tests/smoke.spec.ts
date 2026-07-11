import { test, expect } from '@playwright/test';

test.describe('Landing page', () => {
  test('shows the server discovery headline', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: /검증된 서버를 찾고, 투표와 리뷰로 비교하세요/ }),
    ).toBeVisible();
  });
});

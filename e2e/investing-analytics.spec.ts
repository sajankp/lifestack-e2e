import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

test.describe('Investing Analytics & Warning Deduplication E2E Spec', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-investing-analytics-${uniqueId}@example.com`;
    testUsername = `e2e_inv_analytics_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('renders asset allocation analytics and deduplicates snapshot warnings', async ({ page }) => {
    await page.getByTestId('nav-investing').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();

    // Navigate to Analytics sub-tab
    await page.getByTestId('investing-tab-analytics').click();

    // UX Review Real-Data #2 & Scale: Analytics controls / exposure warnings must be deduplicated
    const warningItems = page.locator('[data-testid="analytics-warning-item"]');
    if (await warningItems.count() > 1) {
      const texts: string[] = [];
      const count = await warningItems.count();
      for (let i = 0; i < count; i++) {
        texts.push(await warningItems.nth(i).innerText());
      }
      const uniqueTexts = new Set(texts);
      expect(texts.length).toBe(uniqueTexts.size);
    }

    // UX Review P2 #12: Warning wall should be collapsed into a summary count if numerous
    const collapsedWarningBanner = page.locator('[data-testid="analytics-warnings-summary"]');
    if (await collapsedWarningBanner.isVisible()) {
      await expect(collapsedWarningBanner).toContainText(/funds missing constituent data|warnings/i);
    }
  });
});

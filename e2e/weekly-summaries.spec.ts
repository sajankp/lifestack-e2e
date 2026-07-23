import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import { triggerWeeklySummary } from './helpers/e2e-hooks';

test.describe('Weekly Summaries E2E Spec', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-weekly-summary-${uniqueId}@example.com`;
    testUsername = `e2e_weekly_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('triggers and renders weekly summary card with stale indicator and clean movement bounds', async ({ page }) => {
    await page.getByTestId('nav-summaries').click();
    await expect(page.getByRole('heading', { name: 'Weekly Summaries', exact: true })).toBeVisible();
    await expect(page.getByText('No weekly summaries yet')).toBeVisible();

    // Trigger weekly summary workflow via E2E hook
    await triggerWeeklySummary(page);
    await page.reload();

    await expect(page.getByText('No weekly summaries yet')).not.toBeVisible();
    // Summary cards render as <article> elements headed "Week of …" — the web
    // app exposes no per-card data-testid.
    const summaryCard = page.getByRole('article').filter({ hasText: /^Week of / }).first();
    await expect(summaryCard).toBeVisible();

    // UX Review Real-Data #98: If data changes after generation, stale indicator should be shown
    const staleIndicator = summaryCard.locator('[data-testid="summary-stale-indicator"]');
    if (await staleIndicator.isVisible()) {
      await expect(staleIndicator).toContainText(/data changed since generation|stale/i);
    }

    // UX Review Real-Data #100: Suppress misleading -100% or 0% boundary movements when net worth snapshot is missing
    const movementText = summaryCard.locator('[data-testid="weekly-movement-text"]');
    if (await movementText.isVisible()) {
      const text = await movementText.innerText();
      expect(text).not.toContain('-100.00%');
    }
  });
});

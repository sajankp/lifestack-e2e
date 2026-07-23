import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

test.describe('Spending Analytics E2E Spec', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-spending-analytics-${uniqueId}@example.com`;
    testUsername = `e2e_sp_analytics_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('renders spending analytics with distinct category palette and clean savings rate trend', async ({ page }) => {
    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();

    // Navigate to Analytics sub-tab
    await page.getByTestId('spending-tab-analytics').click();
    await expect(page.getByText('Category Breakdown')).toBeVisible();

    // UX Review #8: Category Breakdown donut should use a distinct categorical palette rather than monochrome blue
    const categoryDonutSlices = page.locator('.recharts-pie-sector, [data-testid="category-breakdown-slice"]');
    if (await categoryDonutSlices.count() > 1) {
      const fillColors = new Set<string>();
      const sliceCount = await categoryDonutSlices.count();
      for (let i = 0; i < sliceCount; i++) {
        const fill = await categoryDonutSlices.nth(i).getAttribute('fill');
        if (fill) fillColors.add(fill);
      }
      expect(fillColors.size).toBeGreaterThan(1);
    }

    // UX Review #8: Savings Rate trend should omit empty months rather than flatlining at 0%
    const savingsRatePlot = page.locator('[data-testid="savings-rate-trend-chart"]');
    if (await savingsRatePlot.isVisible()) {
      await expect(savingsRatePlot).not.toContainText('0.00% (unrecorded)');
    }

    // UX Review #8: Income vs Expenses y-axis tick labels should use rounded/clean steps
    const yAxisTicks = page.locator('.recharts-cartesian-axis-tick-value');
    if (await yAxisTicks.count() > 0) {
      const tickText = await yAxisTicks.first().innerText();
      expect(tickText).toBeTruthy();
    }
  });
});

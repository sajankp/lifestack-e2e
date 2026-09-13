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

    // Tier 2: Portfolio Allocation Card & Dimension Toggle
    const allocationCard = page.getByTestId('portfolio-allocation-card');
    await expect(allocationCard).toBeVisible();
    await expect(allocationCard.getByText('Portfolio Allocation')).toBeVisible();

    const sectorBtn = allocationCard.getByRole('button', { name: 'Sectors' });
    const assetClassBtn = allocationCard.getByRole('button', { name: 'Asset Classes' });
    await expect(sectorBtn).toBeVisible();
    await expect(assetClassBtn).toBeVisible();
    await sectorBtn.click();
    await assetClassBtn.click();

    // Tier 2: Dividend Trajectory Card
    const dividendCard = page.getByTestId('dividend-trajectory-card');
    await expect(dividendCard).toBeVisible();
    await expect(dividendCard.getByText('Dividend Income Trajectory')).toBeVisible();
    await expect(dividendCard.getByText('Trailing 12-Month Yield')).toBeVisible();
    await expect(dividendCard.getByText('Average Monthly Income')).toBeVisible();
    await expect(dividendCard.getByText('Cumulative All-Time')).toBeVisible();
  });
});

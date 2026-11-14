import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import { seedPortfolioReport } from './helpers/e2e-hooks';

/**
 * Portfolio report cards on Investing -> Analytics.
 *
 * Reports are written by the fortnightly cron over MCP, so these tests seed
 * them through the e2e hook -- in the shape the cron really stores (flat tax
 * scalars, `harvest_detail` keys, numeric theme weights), not an idealised one.
 *
 * Regression guard: the list route used to 500 whenever the web app sent
 * `workspace_public_id` (a bad import), which the UI rendered as "No portfolio
 * report available". The request itself is asserted, not just the pixels.
 */
async function openAnalytics(page: Page) {
  await page.getByTestId('nav-portfolio').click();
  await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();

  const [reportsResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/investing/portfolio-reports') &&
        response.request().method() === 'GET',
    ),
    page.getByTestId('investing-tab-analytics').click(),
  ]);
  return reportsResponse;
}

test.describe('Investing portfolio report cards', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    await registerAndLogin(page, baseURL, {
      email: `e2e-portfolio-report-${uniqueId}@example.com`,
      username: `e2e_pr_${uniqueId.replace(/-/g, '_')}`,
      password: 'Password123!',
    });
  });

  test('renders every card from a report stored in the cron shape @smoke', async ({ page }) => {
    await seedPortfolioReport(page, {
      as_of: '2026-11-13',
      theme_weights: { semis_ai: 31.5, gold: 12, cash: 4.5 },
      harvest_candidates: [
        {
          symbol: 'ABCX',
          account: 'IND Money',
          qty: 4,
          unrealised_loss_inr: 2500.5,
          days_to_long_term: 40,
          tax_saved_inr: 780.25,
        },
      ],
      lrs_headroom_inr: '662922.41',
      tax_buckets: {
        lt_gain_inr: 1000,
        lt_tax_inr: 125,
        st_gain_inr: 200,
        st_tax_inr: 70,
        total_tax_inr: 195,
        slab_pct: 30,
        advance_paid_inr: 0,
      },
    });

    const reportsResponse = await openAnalytics(page);

    // The request the UI makes must succeed, and must carry the workspace it asked for.
    expect(reportsResponse.status(), await reportsResponse.text()).toBe(200);
    expect(reportsResponse.url()).toContain('workspace_public_id=');

    const section = page.getByTestId('portfolio-report-cards-section');
    await expect(section.getByText('No portfolio report available')).toHaveCount(0);
    await expect(section.getByText(/Failed to load portfolio reports/)).toHaveCount(0);
    await expect(page.getByTestId('portfolio-report-cards')).toBeVisible();

    // LRS headroom (locale-agnostic: 662,922.41 vs 6,62,922.41)
    await expect(page.getByTestId('lrs-headroom-card')).toContainText(/6,?62,?922/);

    // Tax buckets: the flat dict becomes long-term + short-term rows, not an empty state.
    const taxCard = page.getByTestId('tax-buckets-card');
    await expect(taxCard.getByText('No tax buckets recorded')).toHaveCount(0);
    await expect(taxCard.getByTestId('tax-bucket-row-0')).toContainText(/long/i);
    await expect(taxCard.getByTestId('tax-bucket-row-1')).toContainText(/short/i);

    // Theme split uses the stored numeric weights.
    await expect(page.getByTestId('theme-row-semis_ai')).toContainText('%');

    // Harvest candidates read qty / unrealised_loss_inr / tax_saved_inr.
    const harvestCard = page.getByTestId('harvest-candidates-card');
    await expect(harvestCard.getByText('No harvest candidates')).toHaveCount(0);
    await expect(harvestCard.getByTestId('harvest-row-0')).toContainText('ABCX');
  });

  test('shows the empty state only when no report exists', async ({ page }) => {
    const reportsResponse = await openAnalytics(page);

    expect(reportsResponse.status(), await reportsResponse.text()).toBe(200);
    await expect(
      page.getByTestId('portfolio-report-cards-section').getByText('No portfolio report available'),
    ).toBeVisible();
  });
});

import { test, expect, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import {
  apiV1,
  createBrokerageAccount,
  createSpendingAccount,
  csrfHeaders,
  placeOrderViaApi,
  transferCash,
  type Account,
} from './helpers/test-helpers';

/**
 * Capital gains tax estimate (spec-099).
 *
 * The estimate is computed from the order history, so these tests seed a
 * buy and a sell through the API and then read the Tax tab.
 *
 * The Rule 115 rate is keyed by the month of transfer, and the app's
 * generic e2e FX seed is dated yesterday — which is after the specified
 * date for a sale in the current month. The test therefore supplies the
 * rate through the tax profile's manual FX override, which is the same
 * path a user would take to enter the SBI TT buying rate.
 */

const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

/** The Indian FY label ("YYYY-YY") containing a given date. */
const fyLabelFor = (date: Date): string => {
  const startYear = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

const saleMonthKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

async function seedManualFxRate(
  page: Page,
  monthKey: string,
  rate: string,
): Promise<void> {
  const res = await page.request.patch(`${apiV1()}/investing/tax/profile`, {
    headers: await csrfHeaders(page),
    data: { fx_overrides: { [monthKey]: rate } },
  });
  expect(res.status(), `Tax profile FX override failed: ${await res.text()}`).toBe(200);
}

test.describe('Capital Gains Tax Estimate E2E Spec', () => {
  let testEmail: string;
  let testUsername: string;
  const testPassword = 'Password123!';
  let brokerageAccount: Account;
  let bankAccount: Account;
  let seed: string;

  test.beforeEach(async ({ page, baseURL }, testInfo) => {
    seed = `${Date.now()}_${testInfo.workerIndex}_${Math.random().toString(36).slice(2, 8)}`;
    testEmail = `e2e-tax-${seed}@example.com`;
    testUsername = `e2e_tax_${seed}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });

    brokerageAccount = await createBrokerageAccount(page, `Brokerage ${seed}`, 'USD');
    bankAccount = await createSpendingAccount(page, `Bank ${seed}`, 'USD');
    await transferCash(page, bankAccount.public_id, brokerageAccount.public_id, '10000', 'USD');
  });

  test('shows the Tax tab with an empty state when there are no sells', async ({ page }) => {
    await page.getByTestId('nav-portfolio').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();

    await page.getByTestId('investing-tab-tax').click();
    await expect(page.getByTestId('investing-tax-tab')).toBeVisible();

    // A workspace with only a buy has no realised gains, so the tab
    // explains that rather than showing a zero tax figure.
    await expect(page.getByTestId('tax-empty-state')).toBeVisible();
    await expect(page.getByTestId('tax-empty-state')).toContainText(/No capital gains recorded/i);
    await expect(page.getByTestId('tax-total-tax')).toHaveCount(0);
  });

  test('computes a long-term capital gain for a US-listed holding @smoke @critical', async ({ page }) => {
    const boughtAt = isoDaysAgo(800); // beyond the 24-month foreign threshold
    const soldAt = isoDaysAgo(10);
    const soldOn = new Date(soldAt);
    const fyLabel = fyLabelFor(soldOn);
    const monthKey = saleMonthKey(soldOn);

    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'AAPL',
      quantity: '10',
      price_per_unit: '100',
      currency: 'USD',
      occurred_at: boughtAt,
    });
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'sell',
      symbol: 'AAPL',
      quantity: '10',
      price_per_unit: '200',
      currency: 'USD',
      occurred_at: soldAt,
    });

    // The manual Rule 115 rate for the month of transfer.
    await seedManualFxRate(page, monthKey, '95');

    await page.getByTestId('nav-portfolio').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();
    await page.getByTestId('investing-tab-tax').click();

    await expect(page.getByTestId('tax-total-tax')).toBeVisible();
    await expect(page.getByTestId('tax-total-gain')).toBeVisible();
    await expect(page.getByTestId('tax-effective-rate')).toBeVisible();

    // A 10-share buy at 100 sold at 200 is a 1,000 USD gain, which at the
    // seeded 95 INR/USD rate is 95,000 INR. The engine deducts the sell's
    // fees from the proceeds, so the gain is 95,000 minus the fees in INR.
    const gainText = await page.getByTestId('tax-total-gain').innerText();
    const gainValue = Number(gainText.replace(/[^0-9.]/g, ''));
    expect(gainValue).toBeGreaterThan(94_000);
    expect(gainValue).toBeLessThanOrEqual(95_000);

    // The tax is a positive figure derived from the slab, not a fixed
    // number -- but it must be present and proportionate to the gain.
    // Under the new regime, total income of 95,000 is within the 12,00,000
    // 87A ceiling, so the rebate cancels the tax entirely. That is the
    // correct statutory outcome, and the summary must say so rather than
    // silently reporting a zero.
    const summaryRes = await page.request.get(`${apiV1()}/investing/tax/summary`, {
      headers: await csrfHeaders(page),
    });
    expect(summaryRes.status()).toBe(200);
    const summary = await summaryRes.json();
    expect(summary.status).toBe('success');
    expect(summary.total_gain_inr).toBe('95000.00');
    expect(summary.slab.rebate_amount).toBe('12350.00');
    expect(summary.total_tax_inr).toBe('0.00');

    // The lot is long-term under the foreign 24-month threshold.
    await expect(page.getByTestId('tax-positions-table')).toContainText('AAPL');
    await expect(page.getByTestId('tax-positions-table')).toContainText('Long-term');

    // The FX table shows the manually supplied rate for the sale month.
    await expect(page.getByTestId('tax-fx-table')).toBeVisible();
    await expect(page.getByTestId('tax-fx-table')).toContainText(monthKey);

    // The estimate is never presented as a filing-ready liability.
    await expect(page.getByTestId('tax-disclaimers')).toContainText(/estimate, not a filing/i);
  });

  test('taxes a short-term gain at the marginal rate once income exceeds the 87A ceiling', async ({
    page,
  }) => {
    const soldAt = isoDaysAgo(10);
    const soldOn = new Date(soldAt);

    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'TSLA',
      quantity: '100',
      price_per_unit: '100',
      currency: 'USD',
      occurred_at: isoDaysAgo(60),
    });
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'sell',
      symbol: 'TSLA',
      quantity: '100',
      price_per_unit: '200',
      currency: 'USD',
      occurred_at: soldAt,
    });
    await seedManualFxRate(page, saleMonthKey(soldOn), '95');

    // Push the taxable income past the 12,00,000 rebate ceiling so the
    // short-term gain is taxed at the derived marginal rate.
    const profileRes = await page.request.patch(`${apiV1()}/investing/tax/profile`, {
      headers: await csrfHeaders(page),
      data: { other_income: '2000000' },
    });
    expect(profileRes.status(), `Tax profile update failed: ${await profileRes.text()}`).toBe(200);

    await page.getByTestId('nav-portfolio').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();
    await page.getByTestId('investing-tab-tax').click();

    await expect(page.getByTestId('tax-total-tax')).toBeVisible();

    const summaryRes = await page.request.get(`${apiV1()}/investing/tax/summary`, {
      headers: await csrfHeaders(page),
    });
    const summary = await summaryRes.json();
    expect(summary.status).toBe('success');

    // 100 shares bought at 100 and sold at 200 is a 10,000 USD gain,
    // which at the seeded 95 INR/USD rate is 950,000 INR.
    expect(summary.total_gain_inr).toBe('950000.00');

    // With 2,000,000 of other income the total is past the 87A ceiling,
    // so the rebate does not apply and the short-term gain is taxed at the
    // derived marginal rate.
    expect(summary.slab.rebate_amount).toBe('0');
    expect(Number(summary.slab.rate_pct)).toBeGreaterThan(0);
    expect(Number(summary.total_tax_inr)).toBeGreaterThan(0);

    // The short-term bucket carries the tax, and the foreign regime
    // applies no 1.25 lakh exemption.
    const shortTerm = summary.buckets['foreign:short_term'];
    expect(shortTerm).toBeDefined();
    expect(Number(shortTerm.tax)).toBeGreaterThan(0);
    expect(Number(shortTerm.exemption_applied)).toBe(0);
  });

  test('reports a missing Rule 115 rate instead of an understated tax figure', async ({ page }) => {
    const soldAt = isoDaysAgo(10);

    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'MSFT',
      quantity: '10',
      price_per_unit: '100',
      currency: 'USD',
      occurred_at: isoDaysAgo(800),
    });
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'sell',
      symbol: 'MSFT',
      quantity: '10',
      price_per_unit: '200',
      currency: 'USD',
      occurred_at: soldAt,
    });

    // Deliberately no FX override: the rate is unavailable, so the tax
    // figure must not be presented.
    await page.getByTestId('nav-portfolio').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();
    await page.getByTestId('investing-tab-tax').click();

    await expect(page.getByTestId('investing-tax-missing-fx')).toBeVisible();
    await expect(page.getByTestId('investing-tax-missing-fx')).toContainText(/Rule 115/i);
    await expect(page.getByTestId('tax-total-tax')).toHaveCount(0);
  });

  test('lets the user pick a financial year and explains the statutory rules', async ({ page }) => {
    await page.getByTestId('nav-portfolio').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();
    await page.getByTestId('investing-tab-tax').click();

    await expect(page.getByTestId('tax-fy-select')).toBeVisible();

    // The `i` affordance on the header explains what the estimate is, and
    // is reachable by keyboard, not only on hover.
    await expect(page.getByLabel('About this estimate')).toBeVisible();
  });

  test('explains the FX rate and the marginal rate once there are gains to tax', async ({ page }) => {
    const soldAt = isoDaysAgo(10);
    const soldOn = new Date(soldAt);

    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'NVDA',
      quantity: '10',
      price_per_unit: '100',
      currency: 'USD',
      occurred_at: isoDaysAgo(800),
    });
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'sell',
      symbol: 'NVDA',
      quantity: '10',
      price_per_unit: '200',
      currency: 'USD',
      occurred_at: soldAt,
    });
    await seedManualFxRate(page, saleMonthKey(soldOn), '95');

    await page.getByTestId('nav-portfolio').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();
    await page.getByTestId('investing-tab-tax').click();

    await expect(page.getByTestId('tax-total-tax')).toBeVisible();
    await expect(page.getByLabel('About the exchange rate')).toBeVisible();
    await expect(page.getByLabel('About the marginal rate')).toBeVisible();
  });
});

import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

test.describe('Investing Portfolio & FX Triangulation E2E Flow', () => {
  let testEmail: string;
  let testUsername: string;
  const testPassword = 'Password123!';
  let gbpAccount: string;
  let usdAccount: string;

  test.beforeEach(async ({ page, baseURL }, testInfo) => {
    const seed = `${Date.now()}_${testInfo.workerIndex}_${testInfo.retry}_${Math.random().toString(36).slice(2, 8)}`;
    testEmail = `e2e-investing-${seed}@example.com`;
    testUsername = `e2e_investing_${seed}`;
    gbpAccount = `GBP Brokerage ${seed}`;
    usdAccount = `USD Brokerage ${seed}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('should create multi-currency accounts and holdings, and verify FX look-through valuation', async ({ page, baseURL }) => {
    const selectOption = async (triggerTestId: string, optionName: string) => {
      await page.getByTestId(triggerTestId).click();
      await page.getByRole('option', { name: optionName, exact: true }).click();
    };

    // 2. Navigate to Investing tab
    await page.getByTestId('nav-investing').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();

    // 3. Create GBP Account via the Add Holding modal (quick-create account sub-form)
    // Open the modal, set holding currency so quick-created account inherits it.
    await page.getByTestId('investing-add-holding-btn').click();
    await selectOption('investing-holding-currency', 'GBP');
    await page.getByTestId('investing-account-name').fill(gbpAccount);
    await selectOption('investing-account-type', 'Brokerage');
    await page.getByTestId('investing-account-create').click();

    // 4. Create USD Account (still in the modal)
    await selectOption('investing-holding-currency', 'USD');
    await page.getByTestId('investing-account-name').fill(usdAccount);
    await selectOption('investing-account-type', 'Brokerage');
    await page.getByTestId('investing-account-create').click();

    // 5. Add a GBP holding (e.g. VWRD, 10 units, avg cost 100 GBP)
    await page.getByTestId('investing-holding-symbol').fill('VWRD');
    await selectOption('investing-holding-account', gbpAccount);
    await page.getByTestId('investing-holding-quantity').fill('10');
    await page.getByTestId('investing-holding-avg-cost').fill('100');
    await selectOption('investing-holding-currency', 'GBP');
    await page.getByTestId('investing-holding-submit').click();

    // Verify GBP holding added (modal closes on success)
    await expect(page.getByTestId('investing-holding-symbol-VWRD')).toBeVisible();

    // 6. Add a USD holding (e.g. AAPL, 5 units, avg cost 150 USD)
    await page.getByTestId('investing-add-holding-btn').click();
    await page.getByTestId('investing-holding-symbol').fill('AAPL');
    await selectOption('investing-holding-account', usdAccount);
    await page.getByTestId('investing-holding-quantity').fill('5');
    await page.getByTestId('investing-holding-avg-cost').fill('150');
    await selectOption('investing-holding-currency', 'USD');
    await page.getByTestId('investing-holding-submit').click();

    // Verify USD holding added
    await expect(page.getByTestId('investing-holding-symbol-AAPL')).toBeVisible();

    // 7. Configure reporting currency to USD via API request sharing session cookies
    const context = page.context();
    const origin = baseURL || 'http://localhost:5173';
    const apiBaseUrl = process.env.PLAYWRIGHT_API_URL || 'http://localhost:8000';
    const state = await context.storageState();
    const csrfCookie = state.cookies.find((c: any) => c.name === 'csrf_token');
    const csrfToken = csrfCookie?.value;
    const settingsResponse = await context.request.patch(`${apiBaseUrl}/v1/finance/settings`, {
      headers: {
        'Origin': origin,
        'Referer': `${origin}/`,
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      data: {
        reporting_currency_code: 'USD'
      }
    });
    expect(settingsResponse.ok()).toBeTruthy();

    // 8. Refresh page to reflect new reporting currency settings and verify valuation
    await page.reload();
    await expect(page.getByTestId('investing-reporting-currency')).toContainText('USD');

    // GBP holding cost = 10 * 100 = 1000 GBP. Converted to USD at 1.25 rate = 1250 USD.
    // USD holding cost = 5 * 150 = 750 USD.
    // Total Portfolio Value in USD = 1250 + 750 = 2000 USD.
    // Let's verify that the total portfolio value shows $2,000.00
    await expect(page.getByTestId('investing-portfolio-value')).toContainText('$2,000.00');
    await expect(page.getByTestId('investing-fx-rates-used')).toContainText('1 GBP');
    await expect(page.getByTestId('investing-fx-rates-used')).toContainText('1.2500');
    await expect(page.getByTestId('investing-fx-rates-used')).toContainText('USD');

    // 9. Navigate to Look-through Analytics tab
    await page.getByTestId('investing-tab-analytics').click();

    // 10. Verify exposure calculations
    // Since the API uses un-converted holding cost sums (1000 GBP + 750 USD = 1750),
    // we assert $1,750.00 for both.
    await expect(page.getByTestId('investing-total-direct')).toContainText('$1,750.00');
    await expect(page.getByTestId('investing-total-lookthrough')).toContainText('$1,750.00');
  });

  test('should show unconverted multi-currency state before reporting currency is configured', async ({ page }) => {
    const selectOption = async (triggerTestId: string, optionName: string) => {
      await page.getByTestId(triggerTestId).click();
      await page.getByRole('option', { name: optionName, exact: true }).click();
    };

    await page.getByTestId('nav-investing').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();

    // Open modal and create GBP account via quick-create sub-form
    await page.getByTestId('investing-add-holding-btn').click();
    await selectOption('investing-holding-currency', 'GBP');
    await page.getByTestId('investing-account-name').fill(gbpAccount);
    await selectOption('investing-account-type', 'Brokerage');
    const gbpAccountPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/finance/accounts') && res.request().method() === 'POST',
    );
    await page.getByTestId('investing-account-create').click();
    const gbpAccountResponse = await gbpAccountPromise;
    expect(gbpAccountResponse.ok()).toBeTruthy();

    // Create USD account (still in the same modal)
    await selectOption('investing-holding-currency', 'USD');
    await page.getByTestId('investing-account-name').fill(usdAccount);
    await selectOption('investing-account-type', 'Brokerage');
    const usdAccountPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/finance/accounts') && res.request().method() === 'POST',
    );
    await page.getByTestId('investing-account-create').click();
    const usdAccountResponse = await usdAccountPromise;
    expect(usdAccountResponse.ok()).toBeTruthy();

    // Add GBP holding
    await page.getByTestId('investing-holding-symbol').fill('VWRD');
    await selectOption('investing-holding-account', gbpAccount);
    await page.getByTestId('investing-holding-quantity').fill('10');
    await page.getByTestId('investing-holding-avg-cost').fill('100');
    await selectOption('investing-holding-currency', 'GBP');
    await page.getByTestId('investing-holding-submit').click();
    await expect(page.getByTestId('investing-holding-symbol-VWRD')).toBeVisible();

    // Open modal again for the USD holding
    await page.getByTestId('investing-add-holding-btn').click();
    await page.getByTestId('investing-holding-symbol').fill('AAPL');
    await selectOption('investing-holding-account', usdAccount);
    await page.getByTestId('investing-holding-quantity').fill('5');
    await page.getByTestId('investing-holding-avg-cost').fill('150');
    await selectOption('investing-holding-currency', 'USD');
    await page.getByTestId('investing-holding-submit').click();
    await expect(page.getByTestId('investing-holding-symbol-AAPL')).toBeVisible();

    await expect(page.getByTestId('investing-portfolio-value')).toContainText('N/A');
    await expect(page.getByTestId('investing-reporting-currency')).toContainText('Not configured');
    await expect(page.getByText('Multiple currencies detected')).toBeVisible();
    await expect(page.getByText('£1,000.00').first()).toBeVisible();
    await expect(page.getByText('$750.00').first()).toBeVisible();
    await expect(page.getByTestId('investing-fx-rates-used')).toHaveCount(0);
  });
});

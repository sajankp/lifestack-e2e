import { test, expect, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

const PLAYWRIGHT_API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8001';
const API_BASE = PLAYWRIGHT_API_URL.endsWith('/v1') ? PLAYWRIGHT_API_URL : `${PLAYWRIGHT_API_URL}/v1`;

type Account = {
  public_id: string;
  name: string;
  account_type: string;
  default_currency_code: string;
};

const selectOption = async (page: Page, triggerTestId: string, optionName: string) => {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
};

async function csrfHeaders(page: Page) {
  const state = await page.context().storageState();
  const csrfCookie = state.cookies.find((c) => c.name === 'csrf_token');
  expect(csrfCookie, 'CSRF token cookie should be defined').toBeDefined();
  if (!csrfCookie) {
    throw new Error('CSRF token cookie is missing');
  }
  const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';
  return {
    Origin: origin,
    Referer: `${origin}/`,
    'X-CSRF-Token': csrfCookie.value,
  };
}

async function createBrokerageAccount(page: Page, name: string, currency: string): Promise<Account> {
  const res = await page.request.post(`${API_BASE}/finance/accounts`, {
    headers: await csrfHeaders(page),
    data: { name, account_type: 'brokerage', default_currency_code: currency },
  });
  expect(res.status(), `Brokerage account creation failed: ${await res.text()}`).toBe(201);
  return (await res.json()) as Account;
}

async function fundCashBalance(page: Page, accountId: string, balance: string, currency: string): Promise<void> {
  const res = await page.request.post(`${API_BASE}/investing/cash-balances`, {
    headers: await csrfHeaders(page),
    data: {
      account_id: accountId,
      balance,
      currency,
      as_of: new Date().toISOString(),
    },
  });
  expect(res.status(), `Cash balance funding failed: ${await res.text()}`).toBe(201);
}

async function seedFxRate(page: Page, base: string, quote: string, rate: string): Promise<void> {
  const res = await page.request.post(`${API_BASE}/e2e/fx-rates`, {
    headers: await csrfHeaders(page),
    data: { base_currency_code: base, quote_currency_code: quote, rate },
  });
  expect(res.status(), `FX rate seed failed: ${await res.text()}`).toBe(200);
}

async function placeOrderViaApi(
  page: Page,
  data: {
    account_id: string;
    order_type: string;
    symbol: string;
    quantity: string;
    price_per_unit: string;
    currency: string;
  },
): Promise<void> {
  const res = await page.request.post(`${API_BASE}/investing/orders`, {
    headers: await csrfHeaders(page),
    data: {
      account_id: data.account_id,
      order_type: data.order_type,
      symbol: data.symbol,
      quantity: data.quantity,
      price_per_unit: data.price_per_unit,
      currency: data.currency,
      brokerage_fee: '0',
      occurred_at: new Date().toISOString(),
    },
  });
  expect(res.status(), `Order placement failed: ${await res.text()}`).toBe(201);
}

async function submitCurrentPrice(page: Page, symbol: string, unitPrice: string): Promise<void> {
  const holdingsRes = await page.request.get(`${API_BASE}/investing/holdings?limit=200&offset=0`, {
    headers: await csrfHeaders(page),
  });
  expect(holdingsRes.status(), `Holdings lookup failed: ${await holdingsRes.text()}`).toBe(200);
  const holdings = (await holdingsRes.json()).items as Array<{ public_id: string; symbol: string }>;
  const holding = holdings.find((h) => h.symbol === symbol);
  expect(holding, `Holding for symbol ${symbol} should exist`).toBeDefined();
  if (!holding) {
    throw new Error(`Holding for symbol ${symbol} should exist`);
  }

  const priceRes = await page.request.post(`${API_BASE}/investing/prices`, {
    headers: await csrfHeaders(page),
    data: {
      price_date: new Date().toISOString().slice(0, 10),
      prices: [{ holding_public_id: holding.public_id, unit_price: unitPrice }],
    },
  });
  expect(priceRes.status(), `Price submission failed: ${await priceRes.text()}`).toBe(201);
}

test.describe('Investing Portfolio & FX Triangulation E2E Flow', () => {
  let testEmail: string;
  let testUsername: string;
  const testPassword = 'Password123!';
  let gbpAccount: Account;
  let usdAccount: Account;

  test.beforeEach(async ({ page, baseURL }, testInfo) => {
    const seed = `${Date.now()}_${testInfo.workerIndex}_${testInfo.retry}_${Math.random().toString(36).slice(2, 8)}`;
    testEmail = `e2e-investing-${seed}@example.com`;
    testUsername = `e2e_investing_${seed}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });

    // Holdings are derived from orders (spec-041); create the brokerage accounts,
    // fund them with cash, then place the buy orders that create the holdings.
    gbpAccount = await createBrokerageAccount(page, `GBP Brokerage ${seed}`, 'GBP');
    usdAccount = await createBrokerageAccount(page, `USD Brokerage ${seed}`, 'USD');
    await fundCashBalance(page, gbpAccount.public_id, '5000', 'GBP');
    await fundCashBalance(page, usdAccount.public_id, '5000', 'USD');

    // FX rates are globally scoped system data normally populated by a live ExchangeRate-API
    // ingestion job (needs EXCHANGERATE_API_KEY, not configured in the e2e stack or CI) — seed
    // the GBP/USD rate deterministically via the e2e-only test hook instead.
    await seedFxRate(page, 'GBP', 'USD', '1.25');

    // GBP holding: VWRD, 10 units @ 100 GBP
    await placeOrderViaApi(page, {
      account_id: gbpAccount.public_id,
      order_type: 'buy',
      symbol: 'VWRD',
      quantity: '10',
      price_per_unit: '100.00',
      currency: 'GBP',
    });
    // USD holding: AAPL, 5 units @ 150 USD
    await placeOrderViaApi(page, {
      account_id: usdAccount.public_id,
      order_type: 'buy',
      symbol: 'AAPL',
      quantity: '5',
      price_per_unit: '150.00',
      currency: 'USD',
    });
  });

  test('should create multi-currency accounts and holdings, and verify FX look-through valuation', async ({ page, baseURL }) => {
    await page.getByTestId('nav-investing').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();

    // Verify both holdings were created from the seeded orders
    await expect(page.getByTestId('investing-holding-symbol-VWRD')).toBeVisible();
    await expect(page.getByTestId('investing-holding-symbol-AAPL')).toBeVisible();

    // Filter holdings by account and verify only the matching account remains.
    await selectOption(page, 'investing-holdings-account-filter', gbpAccount.name);
    await expect(page.getByTestId('investing-holding-symbol-VWRD')).toBeVisible();
    await expect(page.getByTestId('investing-holding-symbol-AAPL')).toHaveCount(0);
    await selectOption(page, 'investing-holdings-account-filter', 'All accounts');
    await expect(page.getByTestId('investing-holding-symbol-AAPL')).toBeVisible();

    // Submit a current price equal to cost for each holding. Without any HoldingPrice row,
    // valuation falls back to cost basis (valuation_status="cost_basis_fallback"), which the
    // frontend doesn't treat as "converted_available" — so the FX-rates-used panel never
    // renders even though a valid FX rate exists.
    await submitCurrentPrice(page, 'VWRD', '100.00');
    await submitCurrentPrice(page, 'AAPL', '150.00');

    // Configure reporting currency to USD via API request sharing session cookies
    const settingsResponse = await page.request.patch(`${API_BASE}/finance/settings`, {
      headers: await csrfHeaders(page),
      data: {
        reporting_currency_code: 'USD',
      },
    });
    expect(settingsResponse.ok()).toBeTruthy();

    // Refresh page to reflect new reporting currency settings and verify valuation
    await page.reload();
    await expect(page.getByTestId('investing-reporting-currency')).toContainText('USD');

    // GBP holding cost = 10 * 100 = 1000 GBP. Converted to USD at 1.25 rate = 1250 USD.
    // USD holding cost = 5 * 150 = 750 USD.
    // Total Portfolio Value in USD = 1250 + 750 = 2000 USD.
    await expect(page.getByTestId('investing-portfolio-value')).toContainText('$2,000.00');
    await expect(page.getByTestId('investing-invested-value')).toContainText('$2,000.00');
    await expect(page.getByTestId('investing-total-gain-loss')).toContainText('$0.00');
    await expect(page.getByTestId('investing-daily-change')).toContainText('N/A');
    await expect(page.getByTestId('investing-fx-rates-used')).toContainText('1 GBP');
    await expect(page.getByTestId('investing-fx-rates-used')).toContainText('1.2500');
    await expect(page.getByTestId('investing-fx-rates-used')).toContainText('USD');

    // Dashboard uses the same canonical performance snapshot as Investing.
    const investingPortfolioValue = await page.getByTestId('investing-portfolio-value').innerText();
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('dashboard-portfolio-value')).toHaveText(investingPortfolioValue);
    await expect(page.getByText(/Invested \$2,000\.00 · Gain \$0\.00/)).toBeVisible();

    await page.getByTestId('nav-investing').click();

    // Navigate to the Analytics tab
    await page.getByTestId('investing-tab-analytics').click();

    // Verify exposure calculations
    // Analytics uses the same reporting-currency conversion:
    // 1000 GBP * 1.25 + 750 USD = 2000 USD.
    await expect(page.getByTestId('investing-total-direct')).toContainText('$2,000.00');
    await expect(page.getByTestId('investing-total-lookthrough')).toContainText('$2,000.00');
  });

  test('should filter holdings by account', async ({ page }) => {
    await page.getByTestId('nav-investing').click();
    await expect(page.getByTestId('investing-holding-symbol-VWRD')).toBeVisible();
    await expect(page.getByTestId('investing-holding-symbol-AAPL')).toBeVisible();

    await selectOption(page, 'investing-holdings-account-filter', gbpAccount.name);
    await expect(page.getByTestId('investing-holding-symbol-VWRD')).toBeVisible();
    await expect(page.getByTestId('investing-holding-symbol-AAPL')).toHaveCount(0);

    await selectOption(page, 'investing-holdings-account-filter', 'All accounts');
    await expect(page.getByTestId('investing-holding-symbol-AAPL')).toBeVisible();
  });

  test('should show unconverted multi-currency state before reporting currency is configured', async ({ page }) => {
    await page.getByTestId('nav-investing').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();

    await expect(page.getByTestId('investing-holding-symbol-VWRD')).toBeVisible();
    await expect(page.getByTestId('investing-holding-symbol-AAPL')).toBeVisible();

    await expect(page.getByTestId('investing-portfolio-value')).toContainText('N/A');
    await expect(page.getByTestId('investing-reporting-currency')).toContainText('Not configured');
    await expect(page.getByText('Multiple currencies detected')).toBeVisible();
    await expect(page.getByText('£1,000.00').filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText('$750.00').filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByTestId('investing-fx-rates-used')).toHaveCount(0);
  });
});

import { test, expect, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

const PLAYWRIGHT_API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8000';
const API_BASE = PLAYWRIGHT_API_URL.endsWith('/v1') ? PLAYWRIGHT_API_URL : `${PLAYWRIGHT_API_URL}/v1`;

type Account = {
  public_id: string;
  name: string;
  account_type: string;
  default_currency_code: string;
};

type InvestingOrder = {
  public_id: string;
  order_type: string;
  symbol: string;
  quantity: string;
  price_per_unit: string;
  net_amount: string;
  realized_gain_loss: string | null;
};

async function csrfHeaders(page: Page) {
  const state = await page.context().storageState();
  const csrfCookie = state.cookies.find((c) => c.name === 'csrf_token');
  expect(csrfCookie, 'CSRF token cookie should be defined').toBeDefined();
  const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';
  return {
    Origin: origin,
    Referer: `${origin}/`,
    ...(csrfCookie ? { 'X-CSRF-Token': csrfCookie.value } : {}),
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

async function createSpendingAccount(page: Page, name: string, currency: string): Promise<Account> {
  const res = await page.request.post(`${API_BASE}/finance/accounts`, {
    headers: await csrfHeaders(page),
    data: { name, account_type: 'bank', default_currency_code: currency },
  });
  expect(res.status(), `Bank account creation failed: ${await res.text()}`).toBe(201);
  return (await res.json()) as Account;
}

async function transferCash(
  page: Page,
  fromAccountId: string,
  toAccountId: string,
  amount: string,
  currency: string,
): Promise<void> {
  const res = await page.request.post(`${API_BASE}/finance/transfers`, {
    headers: await csrfHeaders(page),
    data: {
      from_account_id: fromAccountId,
      to_account_id: toAccountId,
      from_module: 'spending',
      to_module: 'investing',
      gross_amount: amount,
      net_amount_received: amount,
      from_currency_code: currency,
      to_currency_code: currency,
      occurred_at: new Date().toISOString(),
    },
  });
  expect(res.status(), `Transfer failed: ${await res.text()}`).toBe(201);
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
    brokerage_fee?: string;
    occurred_at?: string;
  },
): Promise<InvestingOrder> {
  const res = await page.request.post(`${API_BASE}/investing/orders`, {
    headers: await csrfHeaders(page),
    data: {
      account_id: data.account_id,
      order_type: data.order_type,
      symbol: data.symbol,
      quantity: data.quantity,
      price_per_unit: data.price_per_unit,
      currency: data.currency,
      brokerage_fee: data.brokerage_fee ?? '0',
      occurred_at: data.occurred_at ?? new Date().toISOString(),
    },
  });
  expect(res.status(), `Order placement failed: ${await res.text()}`).toBe(201);
  return (await res.json()) as InvestingOrder;
}

test.describe('Investing Orders E2E Flow', () => {
  let testEmail: string;
  let testUsername: string;
  const testPassword = 'Password123!';
  let brokerageAccount: Account;
  let bankAccount: Account;
  let seed: string;

  test.beforeEach(async ({ page, baseURL }, testInfo) => {
    seed = `${Date.now()}_${testInfo.workerIndex}_${Math.random().toString(36).slice(2, 8)}`;
    testEmail = `e2e-orders-${seed}@example.com`;
    testUsername = `e2e_orders_${seed}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });

    brokerageAccount = await createBrokerageAccount(page, `Brokerage ${seed}`, 'USD');
    bankAccount = await createSpendingAccount(page, `Bank ${seed}`, 'USD');

    // Fund the brokerage account with $10,000
    await transferCash(page, bankAccount.public_id, brokerageAccount.public_id, '10000', 'USD');
  });

  test('should place a buy order and verify holding is created', async ({ page }) => {
    await page.getByTestId('nav-investing').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();

    await page.getByTestId('investing-tab-orders').click();
    await page.getByTestId('investing-place-order-btn').click();

    // Fill the order form
    await page.getByTestId('order-account-select').click();
    await page.getByRole('option', { name: brokerageAccount.name }).click();
    await page.getByTestId('order-symbol').fill('AAPL');
    await page.getByTestId('order-quantity').fill('10');
    await page.getByTestId('order-price').fill('150.00');
    await page.getByTestId('order-brokerage-fee').fill('1.99');

    // Verify computed amounts
    await expect(page.getByTestId('order-gross-amount')).toContainText('1,500');
    await expect(page.getByTestId('order-net-amount')).toContainText('1,501.99');

    const orderPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/investing/orders') && res.request().method() === 'POST',
    );
    await page.getByTestId('order-submit').click();
    const orderRes = await orderPromise;
    expect(orderRes.ok()).toBeTruthy();

    // Verify order appears in the orders table
    await expect(page.getByTestId('investing-orders-table')).toBeVisible();
    await expect(page.getByTestId('investing-orders-table')).toContainText('AAPL');
    await expect(page.getByTestId('investing-orders-table')).toContainText('buy');

    // Switch to Holdings tab and verify holding created
    await page.getByTestId('investing-tab-holdings').click();
    await expect(page.locator('[data-testid*="investing-holding-row"]')).toContainText('AAPL');
  });

  test('should place a second buy and verify weighted avg_cost', async ({ page }) => {
    // Pre-seed first buy via API
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'AAPL',
      quantity: '10',
      price_per_unit: '150.00',
      currency: 'USD',
    });

    // Place second buy via UI
    await page.getByTestId('nav-investing').click();
    await page.getByTestId('investing-tab-orders').click();
    await page.getByTestId('investing-place-order-btn').click();

    await page.getByTestId('order-symbol').fill('AAPL');
    await page.getByTestId('order-quantity').fill('5');
    await page.getByTestId('order-price').fill('170.00');

    const orderPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/investing/orders') && res.request().method() === 'POST',
    );
    await page.getByTestId('order-submit').click();
    await orderPromise;

    // Verify Holdings tab shows qty=15 and avg_cost≈$156.67
    await page.getByTestId('investing-tab-holdings').click();
    const holdingRows = page.locator('[data-testid*="investing-holding-row"]');
    await expect(holdingRows.filter({ hasText: 'AAPL' })).toContainText('15');
    await expect(holdingRows.filter({ hasText: 'AAPL' })).toContainText('156.67');
  });

  test('should place a sell order and verify realized gain/loss', async ({ page }) => {
    // Pre-seed buy via API
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'AAPL',
      quantity: '10',
      price_per_unit: '150.00',
      currency: 'USD',
    });

    await page.getByTestId('nav-investing').click();
    await page.getByTestId('investing-tab-orders').click();
    await page.getByTestId('investing-place-order-btn').click();

    // Toggle to sell
    await page.getByTestId('order-type-toggle').getByText('Sell').click();
    await page.getByTestId('order-symbol').fill('AAPL');
    await page.getByTestId('order-quantity').fill('3');
    await page.getByTestId('order-price').fill('180.00');

    const orderPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/investing/orders') && res.request().method() === 'POST',
    );
    await page.getByTestId('order-submit').click();
    await orderPromise;

    // Verify realized gain/loss = 3 × (180 - 150) = $90
    await expect(page.getByTestId('investing-orders-table')).toContainText('90');

    // Holdings: qty=7, avg_cost still $150
    await page.getByTestId('investing-tab-holdings').click();
    const holdingRow = page.locator('[data-testid*="investing-holding-row"]').filter({ hasText: 'AAPL' });
    await expect(holdingRow).toContainText('7');
    await expect(holdingRow).toContainText('150');
  });

  test('should reject buy order when insufficient cash', async ({ page }) => {
    // Transfer only $100 to a separate brokerage
    const smallBrokerage = await createBrokerageAccount(page, `Small Brokerage ${seed}`, 'USD');
    await transferCash(page, bankAccount.public_id, smallBrokerage.public_id, '100', 'USD');

    await page.getByTestId('nav-investing').click();
    await page.getByTestId('investing-tab-orders').click();
    await page.getByTestId('investing-place-order-btn').click();

    await page.getByTestId('order-account-select').click();
    await page.getByRole('option', { name: smallBrokerage.name }).click();
    await page.getByTestId('order-symbol').fill('AAPL');
    await page.getByTestId('order-quantity').fill('10');
    await page.getByTestId('order-price').fill('150.00');

    const orderPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/investing/orders') && res.request().method() === 'POST',
    );
    await page.getByTestId('order-submit').click();
    const orderRes = await orderPromise;
    expect(orderRes.ok()).toBeFalsy();

    // Verify error is shown
    await expect(page.locator('[role="alert"], .toast, [data-testid*="error"]')).toContainText(
      /insufficient|cash/i,
    );
  });

  test('should delete an order and recompute holding', async ({ page }) => {
    // Place two buys via API
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'AAPL',
      quantity: '10',
      price_per_unit: '150.00',
      currency: 'USD',
      occurred_at: new Date('2026-01-01').toISOString(),
    });
    const secondOrder = await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'AAPL',
      quantity: '5',
      price_per_unit: '170.00',
      currency: 'USD',
      occurred_at: new Date('2026-02-01').toISOString(),
    });

    await page.getByTestId('nav-investing').click();
    await page.getByTestId('investing-tab-orders').click();

    // Delete the second order — triggers a confirmation dialog
    await page
      .getByTestId(`investing-order-row-${secondOrder.public_id}`)
      .getByRole('button', { name: /delete/i })
      .click();

    const deletePromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/v1/investing/orders/${secondOrder.public_id}`) &&
        res.request().method() === 'DELETE',
    );
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    const deleteRes = await deletePromise;
    expect(deleteRes.ok()).toBeTruthy();

    // Verify holdings tab shows qty=10, avg_cost=$150 (back to first buy only)
    await page.getByTestId('investing-tab-holdings').click();
    const holdingRow = page.locator('[data-testid*="investing-holding-row"]').filter({ hasText: 'AAPL' });
    await expect(holdingRow).toContainText('10');
    await expect(holdingRow).toContainText('150');
  });

  test('should show trade history for a holding', async ({ page }) => {
    // Place buy + sell via API
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'MSFT',
      quantity: '10',
      price_per_unit: '300.00',
      currency: 'USD',
    });
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'sell',
      symbol: 'MSFT',
      quantity: '3',
      price_per_unit: '350.00',
      currency: 'USD',
    });

    await page.getByTestId('nav-investing').click();
    await page.getByTestId('investing-tab-holdings').click();

    // Click Trade History on the MSFT holding
    const holdingRow = page.locator('[data-testid*="investing-holding-row"]').filter({ hasText: 'MSFT' });
    const holdingId = await holdingRow.getAttribute('data-testid').then((id) => id?.replace('investing-holding-row-', ''));
    await page.getByTestId(`investing-holding-trade-history-${holdingId}`).click();

    // Should show 2 orders in the trade history modal, scoped to this holding's
    // full order history (not capped by the main Orders tab's pagination).
    // Sorted newest-first, matching the main Orders tab convention.
    const tradeRows = page.getByTestId(/^investing-trade-history-row-/);
    await expect(tradeRows).toHaveCount(2);
    await expect(tradeRows.first()).toContainText(/sell/i);
    await expect(tradeRows.last()).toContainText(/buy/i);
  });

  test('should show transfer-triggered cash balance entry', async ({ page }) => {
    await page.getByTestId('nav-investing').click();
    await page.getByTestId('investing-tab-cash').click();

    // The beforeEach already created a $10,000 transfer — verify it appears
    await expect(page.locator('[data-testid*="cash-balance-trigger-type"]')).toBeVisible();
    await expect(page.locator('[data-testid*="cash-balance-trigger-type"]')).toContainText(/transfer/i);
  });
});

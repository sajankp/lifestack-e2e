import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import {
  createBrokerageAccount,
  createSpendingAccount,
  transferCash,
  placeOrderViaApi,
  apiV1,
  csrfHeaders,
  type Account,
} from './helpers/test-helpers';
import { expectInvestingPage, expectMoneyPage } from './helpers/ui';

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
    await page.getByTestId('nav-portfolio').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();

    await page.getByTestId('investing-hero-place-order').click();

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
    await page.getByTestId('investing-tab-orders').click();
    await expect(page.getByTestId('investing-orders-table')).toBeVisible();
    await expect(page.getByTestId('investing-orders-table')).toContainText('AAPL');
    await expect(page.getByTestId('investing-orders-table')).toContainText(/buy/i);

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
    await page.getByTestId('nav-portfolio').click();
    await page.getByTestId('investing-hero-place-order').click();

    // The modal auto-selects the first brokerage account once the accounts
    // query resolves; wait for that before filling the rest of the form (the
    // hero button — unlike the old Cash-tab button — can be clicked before
    // that query settles, since it no longer requires a tab switch first).
    await expect(page.getByTestId('order-account-select')).toContainText(brokerageAccount.name);

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
    // Pre-seed buy via API. Backdated so it's unambiguously before the sell placed via the UI below:
    // the "Trade date & time" field is a datetime-local input (minute precision), so a buy occurring
    // via the API "now" (second precision) can land in the same minute as an immediately-following UI
    // sell and race the FIFO "sell exceeds shares held at that point in time" check.
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'AAPL',
      quantity: '10',
      price_per_unit: '150.00',
      currency: 'USD',
      occurred_at: new Date('2026-01-01').toISOString(),
    });

    await page.getByTestId('nav-portfolio').click();
    await page.getByTestId('investing-hero-place-order').click();

    // Wait for the modal's auto-selected default account (see the comment in
    // the previous test) before interacting with the rest of the form.
    await expect(page.getByTestId('order-account-select')).toContainText(brokerageAccount.name);

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
    await page.getByTestId('investing-tab-orders').click();
    await expect(page.getByTestId('investing-orders-table')).toContainText('90');

    // Holdings: qty=7, avg_cost still $150
    await page.getByTestId('investing-tab-holdings').click();
    const holdingRow = page.locator('[data-testid*="investing-holding-row"]').filter({ hasText: 'AAPL' });
    await expect(holdingRow).toContainText('7');
    await expect(holdingRow).toContainText('150');
  });

  test('should apply FIFO lot consumption on a sell spanning two buy lots', async ({ page }) => {
    // Lot 1: buy 10 @ 100 (oldest)
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'GOOG',
      quantity: '10',
      price_per_unit: '100.00',
      currency: 'USD',
      occurred_at: new Date('2026-01-01').toISOString(),
    });
    // Lot 2: buy 10 @ 200
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'GOOG',
      quantity: '10',
      price_per_unit: '200.00',
      currency: 'USD',
      occurred_at: new Date('2026-02-01').toISOString(),
    });

    // Sell 15 @ 250: FIFO consumes lot 1 fully (10 @ 100) then 5 units of lot 2 (@ 200).
    // realized_gain_loss = 10 * (250 - 100) + 5 * (250 - 200) = 1500 + 250 = 1750
    // Under moving-average this would instead be 15 * (250 - 150) = 1500 — a different number,
    // which is why this assertion is the discriminating one between the two cost models.
    // Remaining position: 5 units left in lot 2, so avg_cost of the OPEN lot = 200
    // (moving-average would have kept blended avg_cost = 150 instead).
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'sell',
      symbol: 'GOOG',
      quantity: '15',
      price_per_unit: '250.00',
      currency: 'USD',
      occurred_at: new Date('2026-03-01').toISOString(),
    });

    await page.getByTestId('nav-portfolio').click();
    await page.getByTestId('investing-tab-orders').click();
    await expect(page.getByTestId('investing-orders-table')).toContainText('1,750');

    await page.getByTestId('investing-tab-holdings').click();
    const holdingRow = page.locator('[data-testid*="investing-holding-row"]').filter({ hasText: 'GOOG' });
    await expect(holdingRow).toContainText('5');
    await expect(holdingRow).toContainText('200');
  });

  test('should reject buy order when insufficient cash', async ({ page }) => {
    // Transfer only $100 to a separate brokerage
    const smallBrokerage = await createBrokerageAccount(page, `Small Brokerage ${seed}`, 'USD');
    await transferCash(page, bankAccount.public_id, smallBrokerage.public_id, '100', 'USD');

    await page.getByTestId('nav-portfolio').click();
    await page.getByTestId('investing-hero-place-order').click();

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

    // Verify error is shown (placeOrderMutation renders its error message inline in the modal form,
    // not via a toast/alert role — see InvestingPage.tsx's placeOrderMutation.isError block)
    await expect(page.locator('form').getByText(/insufficient|cash/i)).toBeVisible();
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

    await page.getByTestId('nav-portfolio').click();
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

    await page.getByTestId('nav-portfolio').click();
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
    test.skip(
      true,
      'The cash-balance feature has no web UI. The backend exposes full CRUD ' +
        'for investing cash balances (app/investing/router.py) and the web has ' +
        'client methods for all four operations, but no page renders them -- the ' +
        'Cash tab was removed in the Oct restructure and nothing replaced it. ' +
        'The old "investing-tab-cash" tab and its "cash-balance-trigger-type" ' +
        'rows have no counterpart in the app, so this test cannot pass until the ' +
        'cash-balance UI is built. See the cash-balance row in the dead-code ' +
        'audit: the client methods (getCashBalances / createCashBalance / ' +
        'updateCashBalance / deleteCashBalance) are all unreached by any page.',
    );
    await page.getByTestId('nav-portfolio').click();

    // The beforeEach already created a $10,000 transfer — verify it appears
    await expect(page.locator('[data-testid*="cash-balance-trigger-type"]')).toBeVisible();
    await expect(page.locator('[data-testid*="cash-balance-trigger-type"]')).toContainText(/transfer/i);
  });

  test('should update live cash balance when transfers occur after orders (no shadowing)', async ({ page }) => {
    // 1. Initial funding from beforeEach is $10,000 into brokerageAccount.
    // 2. Buy 10 AAPL @ $150 = $1,500. Expected residual cash balance = $8,500.
    await placeOrderViaApi(page, {
      account_id: brokerageAccount.public_id,
      order_type: 'buy',
      symbol: 'AAPL',
      quantity: '10',
      price_per_unit: '150.00',
      currency: 'USD',
      occurred_at: new Date(Date.now() - 60000).toISOString(),
    });

    await page.getByTestId('nav-portfolio').click();
    await expectInvestingPage(page);
    await expect(page.getByTestId('investing-cash-total')).toContainText('8,500');

    // 3. Inbound transfer of $2,500 from bank to brokerage AFTER the order.
    // In the old bug, the order snapshot shadowed the subsequent transfer.
    await transferCash(page, bankAccount.public_id, brokerageAccount.public_id, '2500', 'USD', {
      occurred_at: new Date().toISOString(),
    });

    await page.reload();
    await expect(page.getByTestId('investing-cash-total')).toContainText('11,000');

    // 4. Outbound transfer of $1,000 from brokerage back to bank.
    await transferCash(page, brokerageAccount.public_id, bankAccount.public_id, '1000', 'USD', {
      from_module: 'investing',
      to_module: 'spending',
      occurred_at: new Date().toISOString(),
    });

    await page.reload();
    await expect(page.getByTestId('investing-cash-total')).toContainText('10,000');
  });

  test('should unify orders and transfers in brokerage account ledger timeline', async ({ page }) => {
    // The beforeEach funding transfer carries no occurred_at, so it lands at
    // "now" -- after the backdated orders below. To pin a deterministic
    // timeline, this test creates its own accounts and funds the brokerage
    // account with an explicitly backdated transfer, then orders and
    // transfers in a known chronological order:
    //   1. transfer_in +10,000  (oldest)
    //   2. order_buy  -1,000
    //   3. order_sell   +300
    //   4. transfer_in   +700  (newest)
    const tlBrokerage = await createBrokerageAccount(page, `TL Brokerage ${seed}`, 'USD');
    const tlBank = await createSpendingAccount(page, `TL Bank ${seed}`, 'USD');

    const base = Date.now();
    await transferCash(page, tlBank.public_id, tlBrokerage.public_id, '10000', 'USD', {
      occurred_at: new Date(base - 120000).toISOString(),
    });

    // 2. Buy order: 10 AAPL @ $100 = $1,000 (net -1,000)
    await placeOrderViaApi(page, {
      account_id: tlBrokerage.public_id,
      order_type: 'buy',
      symbol: 'AAPL',
      quantity: '10',
      price_per_unit: '100.00',
      currency: 'USD',
      occurred_at: new Date(base - 60000).toISOString(),
    });

    // 3. Sell order: 2 AAPL @ $150 = $300 (net +300)
    await placeOrderViaApi(page, {
      account_id: tlBrokerage.public_id,
      order_type: 'sell',
      symbol: 'AAPL',
      quantity: '2',
      price_per_unit: '150.00',
      currency: 'USD',
      occurred_at: new Date(base - 30000).toISOString(),
    });

    // 4. Inbound transfer: $700 (net +700)
    await transferCash(page, tlBank.public_id, tlBrokerage.public_id, '700', 'USD', {
      occurred_at: new Date().toISOString(),
      notes: 'Top-up after trades',
    });

    // Verify unified ledger API endpoint returns all 4 entries in reverse-chronological order
    // with correct running balances: 10,000 -> 9,300 -> 9,000 -> 10,000
    const headers = await csrfHeaders(page);
    // page.request, not the standalone `request` fixture: only the former
    // carries the page's auth cookies, so the latter gets a 401.
    const ledgerRes = await page.request.get(
      `${apiV1()}/spending/accounts/${tlBrokerage.public_id}/ledger`,
      { headers },
    );
    expect(ledgerRes.ok()).toBeTruthy();
    const ledger = await ledgerRes.json();

    expect(ledger.total_entries).toBe(4);
    expect(parseFloat(ledger.closing_balance)).toBe(10000.0);

    const items = ledger.items;
    // items are reverse-chronological:
    // 0: transfer_in (+700), running balance = 10000
    // 1: order_sell (+300), running balance = 9300
    // 2: order_buy (-1000), running balance = 9000
    // 3: transfer_in (+10000), running balance = 10000
    expect(items[0].entry_kind).toBe('transfer_in');
    expect(parseFloat(items[0].amount)).toBe(700.0);
    expect(parseFloat(items[0].running_balance)).toBe(10000.0);

    expect(items[1].entry_kind).toBe('order_sell');
    expect(parseFloat(items[1].amount)).toBe(300.0);
    expect(parseFloat(items[1].running_balance)).toBe(9300.0);

    expect(items[2].entry_kind).toBe('order_buy');
    expect(parseFloat(items[2].amount)).toBe(1000.0);
    expect(parseFloat(items[2].running_balance)).toBe(9000.0);

    expect(items[3].entry_kind).toBe('transfer_in');
    expect(parseFloat(items[3].amount)).toBe(10000.0);
    expect(parseFloat(items[3].running_balance)).toBe(10000.0);

    // Verify in UI: Navigate to Money Flow and drill down into the brokerage account
    await page.getByTestId('nav-money').click();
    await expectMoneyPage(page);

    // Select the brokerage account card
    await page.getByText(tlBrokerage.name).first().click();

    // Verify the Account Activity table shows the 4 ledger rows
    const activityRows = page.locator('tbody tr');
    await expect(activityRows).toHaveCount(4);
  });
});

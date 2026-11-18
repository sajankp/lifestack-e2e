import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { registerAndLogin } from './helpers/auth';
import { apiV1, csrfHeaders, createSpendingAccount, createBrokerageAccount } from './helpers/test-helpers';

test.describe('Activity Feed Category Filter (spec-087)', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';
  let bankAccount: Awaited<ReturnType<typeof createSpendingAccount>>;
  let customCategoryId = '';
  let customCategoryName = '';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-activity-filter-${uniqueId}@example.com`;
    testUsername = `e2e_af_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });

    // Create a bank account
    bankAccount = await createSpendingAccount(page, `Bank ${uniqueId.slice(0, 8)}`, 'USD');

    // Create a custom category
    customCategoryName = `Test Category ${uniqueId.slice(0, 8)}`;
    const catRes = await page.request.post(`${apiV1()}/spending/categories`, {
      headers: await csrfHeaders(page),
      data: { name: customCategoryName, color: '#ef4444' },
    });
    expect(catRes.ok()).toBeTruthy();
    const catData = await catRes.json();
    customCategoryId = catData.public_id;
  });

  test('filters activity feed by spending category', async ({ page }) => {
    // Create transactions in different categories
    await page.request.post(`${apiV1()}/spending/transactions`, {
      headers: await csrfHeaders(page),
      data: {
        account_id: bankAccount.public_id,
        category_id: customCategoryId,
        amount: '50.00',
        type: 'expense',
        occurred_at: '2026-07-01T12:00:00Z',
        description: 'Custom category spend',
      },
    });

    // Get a default category
    const catsRes = await page.request.get(`${apiV1()}/spending/categories`);
    const cats = (await catsRes.json()).items;
    const defaultCat = cats.find((c: any) => c.public_id !== customCategoryId);
    expect(defaultCat).toBeDefined();

    await page.request.post(`${apiV1()}/spending/transactions`, {
      headers: await csrfHeaders(page),
      data: {
        account_id: bankAccount.public_id,
        category_id: defaultCat.public_id,
        amount: '75.00',
        type: 'expense',
        occurred_at: '2026-07-01T13:00:00Z',
        description: 'Default category spend',
      },
    });

    // Navigate to Money page (where activity feed lives)
    await page.getByTestId('nav-money').click();
    await expect(page.getByRole('heading', { name: 'Money Flow & Architecture' })).toBeVisible();

    // Wait for feed to load (category filter dropdown appears when feed loads)
    await expect(page.getByTestId('activity-feed-category-filter')).toBeVisible();

    // Open category filter dropdown and select custom category
    await page.getByTestId('activity-feed-category-filter').click();
    await page.getByRole('option', { name: customCategoryName, exact: true }).click();

    // Wait for feed to refetch with filter
    await expect(page.getByTestId('activity-feed-category-filter')).toBeVisible();

    // Should only show the custom category transaction
    await expect(page.getByText('Custom category spend')).toBeVisible();
    await expect(page.getByText('Default category spend')).toHaveCount(0);

    // Clear filter
    await page.getByTestId('activity-feed-category-filter').click();
    await page.getByRole('option', { name: 'All Categories', exact: true }).click();

    // Both should be visible again
    await expect(page.getByText('Custom category spend')).toBeVisible();
    await expect(page.getByText('Default category spend')).toBeVisible();
  });

  test('category filter combines with account filter', async ({ page }) => {
    // Create second account
    const bank2 = await createSpendingAccount(page, `Bank2 ${randomUUID().slice(0, 8)}`, 'USD');

    // Transaction in custom category on bank1
    await page.request.post(`${apiV1()}/spending/transactions`, {
      headers: await csrfHeaders(page),
      data: {
        account_id: bankAccount.public_id,
        category_id: customCategoryId,
        amount: '100.00',
        type: 'expense',
        occurred_at: '2026-07-02T12:00:00Z',
        description: 'Custom cat on bank1',
      },
    });

    // Transaction in custom category on bank2
    await page.request.post(`${apiV1()}/spending/transactions`, {
      headers: await csrfHeaders(page),
      data: {
        account_id: bank2.public_id,
        category_id: customCategoryId,
        amount: '200.00',
        type: 'expense',
        occurred_at: '2026-07-02T13:00:00Z',
        description: 'Custom cat on bank2',
      },
    });

    await page.getByTestId('nav-money').click();
    await expect(page.getByTestId('activity-feed-category-filter')).toBeVisible();

    // Filter by custom category only
    await page.getByTestId('activity-feed-category-filter').click();
    await page.getByRole('option', { name: customCategoryName, exact: true }).click();
    await expect(page.getByText('Custom cat on bank1')).toBeVisible();
    await expect(page.getByText('Custom cat on bank2')).toBeVisible();

    // Now also filter by bank1 account
    await page.getByTestId('activity-feed-account-filter').click();
    await page.getByRole('option', { name: `${bankAccount.name} (bank)`, exact: true }).click();

    // Should only show bank1 transaction
    await expect(page.getByText('Custom cat on bank1')).toBeVisible();
    await expect(page.getByText('Custom cat on bank2')).toHaveCount(0);
  });

  test('category filter is disabled for non-spend event types', async ({ page }) => {
    // Create a brokerage account and place an order (creates 'order' event type)
    const brokerage = await createBrokerageAccount(page, `Brokerage ${randomUUID().slice(0, 8)}`, 'USD');
    await page.request.post(`${apiV1()}/investing/cash-balances`, {
      headers: await csrfHeaders(page),
      data: { account_id: brokerage.public_id, balance: '5000', currency: 'USD', as_of: new Date().toISOString() },
    });
    await page.request.post(`${apiV1()}/investing/orders`, {
      headers: await csrfHeaders(page),
      data: {
        account_id: brokerage.public_id,
        order_type: 'buy',
        symbol: 'AAPL',
        quantity: '10',
        price_per_unit: '150.00',
        currency: 'USD',
        occurred_at: new Date().toISOString(),
      },
    });

    await page.getByTestId('nav-money').click();
    await expect(page.getByTestId('activity-feed-category-filter')).toBeVisible();

    // Select 'Trades' event type filter
    await page.getByRole('button', { name: 'Trades', exact: true }).click();

    // Category filter should be disabled
    await expect(page.getByTestId('activity-feed-category-filter')).toBeDisabled();
  });
});
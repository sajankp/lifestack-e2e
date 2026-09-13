import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import {
  apiV1,
  csrfHeaders,
  createBrokerageAccount,
  placeOrderViaApi,
} from './helpers/test-helpers';

// Coverage for spec-071 (return metrics UI, Investing > Analytics) and
// spec-072 (historical data UI, Net Worth > Add historical data).
test.describe('Investing Return Metrics & Net Worth Historical Data E2E Flow', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-returns-${uniqueId}@example.com`;
    testUsername = `e2e_returns_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('shows return metrics for an open position and toggles to exited positions', async ({ page }) => {
    const account = await createBrokerageAccount(
      page,
      `Returns Brokerage ${randomUUID().slice(0, 8)}`,
      'USD',
    );

    const cashRes = await page.request.post(`${apiV1()}/investing/cash-balances`, {
      headers: await csrfHeaders(page),
      data: { account_id: account.public_id, balance: '5000', currency: 'USD', as_of: new Date().toISOString() },
    });
    expect(cashRes.status()).toBe(201);

    await placeOrderViaApi(page, {
      account_id: account.public_id,
      order_type: 'buy',
      symbol: 'MSFT',
      quantity: '5',
      price_per_unit: '100.00',
      currency: 'USD',
      brokerage_fee: '0',
    });

    // Price above cost gives the return metrics panel a nonzero unrealized gain to show.
    const holdingsRes = await page.request.get(`${apiV1()}/investing/holdings?limit=200&offset=0`, {
      headers: await csrfHeaders(page),
    });
    const holding = (await holdingsRes.json()).items.find((h: { symbol: string }) => h.symbol === 'MSFT');
    await page.request.post(`${apiV1()}/investing/prices`, {
      headers: await csrfHeaders(page),
      data: {
        price_date: new Date().toISOString().slice(0, 10),
        prices: [{ holding_public_id: holding.public_id, unit_price: '120.00' }],
      },
    });

    await page.getByTestId('nav-investing').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();
    await page.getByTestId('investing-tab-analytics').click();

    // Under a year old, INV-7 suppresses annualized/XIRR in favor of the simple
    // total return + holding period — assert the metric renders at all.
    await expect(page.getByTestId('investing-xirr-overall')).toBeVisible();
    await expect(page.getByTestId('investing-xirr-overall')).toContainText('%');

    await expect(page.getByText('Current holdings').first()).toBeVisible();
    await expect(page.getByText('Unrealized', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Exited positions' }).click();
    await expect(page.getByText('No exited positions yet.')).toBeVisible();
  });

  test('imports a net-worth backfill point and deletes it', async ({ page }) => {
    // A backfill point must be strictly before the earliest live net-worth
    // snapshot date — comfortably in the past avoids that edge for a fresh workspace.
    const backfillDate = new Date();
    backfillDate.setDate(backfillDate.getDate() - 90);
    const isoDate = backfillDate.toISOString().slice(0, 10);

    const csvContent = [
      'date,total_net_worth,holdings_value,investing_cash,spending_cash,reporting_currency',
      `${isoDate},10000,6000,3000,1000,USD`,
    ].join('\n');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifestack-networth-'));
    const csvPath = path.join(tmpDir, 'networth-backfill.csv');
    try {
      await fs.writeFile(csvPath, csvContent, 'utf8');

      await page.click('a[href="/imports"]');
      await expect(page.getByRole('heading', { name: 'Bulk Imports' })).toBeVisible();
      await page.getByRole('button', { name: 'New Import' }).click();
      await page.getByTestId('imports-module-select').selectOption('finance-net-worth-history');
      await page.getByTestId('imports-file-input').setInputFiles(csvPath);
      await page.getByTestId('imports-upload-validate').click();

      const commitButton = page.getByTestId('imports-commit');
      await expect(commitButton).toBeEnabled({ timeout: 20000 });
      await commitButton.click();

      const statusLine = page.locator('p').filter({ hasText: 'Status:' }).first();
      await expect(statusLine).toContainText('Completed', { timeout: 30000 });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }

    await page.getByTestId('nav-net-worth').click();
    await expect(page.getByRole('heading', { name: 'Net Worth' })).toBeVisible();
    await page.getByTestId('historical-data-open').click();
    await expect(page.getByRole('heading', { name: 'Add historical data' })).toBeVisible();

    const row = page.locator('[data-testid^="historical-networth-row-"]').first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('$10,000.00');

    const rowTestId = await row.getAttribute('data-testid');
    const pointId = rowTestId!.replace('historical-networth-row-', '');
    const deletePromise = page.waitForResponse(
      (res) => res.url().includes(`/net-worth/history/user-points/${pointId}`) && res.request().method() === 'DELETE'
    );
    await page.getByTestId(`historical-networth-delete-${pointId}`).click();
    const deleteResponse = await deletePromise;
    expect(deleteResponse.ok()).toBeTruthy();
    await expect(page.getByTestId(`historical-networth-row-${pointId}`)).toHaveCount(0);
  });
});

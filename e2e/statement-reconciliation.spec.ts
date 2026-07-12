import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

// Coverage for spec-078 (wallet ledger reconciliation): import a bank
// statement CSV against a wallet account, then match an unmatched statement
// line to an existing spending transaction and confirm it moves to Matched.
test.describe('Statement Reconciliation E2E Flow', () => {
  let testEmail = '';
  let testUsername = '';
  let accountName = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-reconcile-${uniqueId}@example.com`;
    testUsername = `e2e_reconcile_${uniqueId.replace(/-/g, '_')}`;
    accountName = `Reconcile Wallet ${uniqueId.slice(0, 8)}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });

    await page.getByTestId('nav-settings').click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByTestId('settings-tab-accounts').click();
    await page.getByTestId('master-account-name').fill(accountName);
    await page.getByTestId('master-account-currency').click();
    await page.getByRole('option', { name: /^USD\b/ }).click();
    const accountPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/finance/accounts') && res.request().method() === 'POST'
    );
    await page.getByTestId('master-account-create').click();
    const accountResponse = await accountPromise;
    expect(accountResponse.ok()).toBeTruthy();
  });

  test('imports a statement and matches a line to an existing transaction @smoke', async ({ page }) => {
    const selectFromCombobox = async (trigger: ReturnType<typeof page.getByTestId>, optionName: string) => {
      await trigger.click();
      await page.getByRole('option', { name: optionName, exact: true }).click();
    };

    // Log an expense transaction that the statement line below should match:
    // exact signed amount, within a 3-day window (spec-078).
    const today = new Date();
    const isoDate = today.toISOString().slice(0, 10);
    const description = `Reconcile txn ${randomUUID().slice(0, 8)}`;

    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();
    await page.getByTestId('spending-open-new-transaction').click();
    await page.getByTestId('spending-transaction-amount').fill('42.50');
    await page.getByTestId('spending-transaction-category').click();
    await page.getByRole('option').first().click();
    await selectFromCombobox(page.getByTestId('spending-transaction-account'), `${accountName} (wallet)`);
    await page.getByTestId('spending-transaction-description').fill(description);
    const transactionPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/spending/transactions') && res.request().method() === 'POST'
    );
    await page.getByTestId('spending-transaction-save').click();
    const transactionResponse = await transactionPromise;
    expect(transactionResponse.ok()).toBeTruthy();

    // Build and import a statement CSV with one debit line that matches the
    // transaction above (date, description, debit).
    const csvContent = [
      'date,description,debit,credit,balance',
      `${isoDate},Statement line for ${description},42.50,,957.50`,
    ].join('\n');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifestack-statement-'));
    const csvPath = path.join(tmpDir, 'statement.csv');
    try {
      await fs.writeFile(csvPath, csvContent, 'utf8');

      await page.click('a[href="/imports"]');
      await expect(page.getByRole('heading', { name: 'Bulk Imports' })).toBeVisible();
      await page.getByRole('button', { name: 'New Import' }).click();
      await page.getByTestId('imports-module-select').selectOption('finance-account-statement');
      await selectFromCombobox(page.getByTestId('imports-target-account-statement'), `${accountName} (wallet)`);
      await page.getByTestId('imports-statement-date-format').selectOption('yyyy-MM-dd');
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

    // Navigate to the Ledger tab and reconcile the imported statement against
    // the wallet's transactions.
    await page.getByTestId('nav-spending').click();
    await page.getByTestId('spending-tab-ledger').click();
    await page.getByTestId('ledger-account-select').selectOption({ label: `${accountName} (wallet)` });

    await expect(page.getByTestId('statement-unmatched-line')).toContainText(`Statement line for ${description}`);
    const matchPromise = page.waitForResponse(
      (res) => res.url().includes('/statements/') && res.url().includes('/lines/') && res.request().method() === 'POST'
    );
    await page.getByTestId('statement-match-candidate').first().click();
    const matchResponse = await matchPromise;
    expect(matchResponse.ok()).toBeTruthy();

    await expect(page.getByTestId('statement-matched-line')).toContainText(`Statement line for ${description}`);
    await expect(page.getByTestId('statement-unmatched-line')).toHaveCount(0);
  });
});

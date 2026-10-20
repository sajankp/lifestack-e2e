import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import { expectSpendingPage } from './helpers/ui';

// Coverage for spec-078 (wallet ledger reconciliation): import a bank
// statement CSV against a wallet account, then match an unmatched statement
// line to an existing spending transaction and confirm it moves to Matched.
//
// SKIPPED: the statement-reconciliation UI is no longer reachable. The Oct 2
// web restructure (web PR #262, "streamline SpendingPage to 4 planning tabs")
// deleted src/pages/spending/LedgerTab.tsx, which was the only page that
// rendered src/components/finance/StatementReconciliation.tsx. That
// component is now imported only by its own unit test, so none of the
// statement-* test ids exist on any route (/money, /spending, /imports,
// /portfolio were each checked). The API endpoints
// (GET /v1/finance/accounts/{id}/statements and
// GET .../statements/{id}/reconciliation) are still live, so the backend
// capability is intact and only the UI is missing.
//
// This spec is skipped rather than deleted so the coverage can be restored
// once the component is wired back into a page. Do not "fix" it by pointing
// the selectors at a different page — that would assert the wrong thing.
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

  test('imports a statement and matches a line to an existing transaction @smoke @critical', async ({ page }) => {
    test.skip(
      true,
      'Statement-reconciliation UI is unreachable: web PR #262 deleted LedgerTab.tsx, ' +
        'which was the only renderer of StatementReconciliation.tsx. The backend ' +
        'endpoints still work, so restore the UI and re-enable this spec.',
    );

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
    await expectSpendingPage(page);
    await page.getByTestId('header-quick-spending').click();
    await page.getByTestId('transaction-amount-input').fill('42.50');
    // Select a real seeded category instead of assuming the first option is a
    // category; the first option may be "+ Create new" and open a modal.
    await selectFromCombobox(page.getByTestId('transaction-category-select'), 'Food & Dining');
    await selectFromCombobox(page.getByTestId('transaction-account-select'), `${accountName} (wallet)`);
    await page.getByTestId('transaction-description-input').fill(description);
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
    await page.getByTestId('ledger-account-select').click();
    await page.getByRole('option', { name: `${accountName} (wallet)`, exact: true }).click();

    await expect(page.getByTestId('statement-unmatched-line')).toContainText(`Statement line for ${description}`);
    const matchPromise = page.waitForResponse(
      (res) => res.url().includes('/statements/') && res.url().includes('/lines/') && res.request().method() === 'POST'
    );
    await page.getByTestId('statement-match-candidate').first().click();
    const matchResponse = await matchPromise;
    expect(matchResponse.ok()).toBeTruthy();

    // Matching invalidates the reconciliation query asynchronously; wait for
    // the refetch rather than assuming the mutation response rendered it.
    await expect(page.getByTestId('statement-matched-line')).toContainText(
      `Statement line for ${description}`,
      { timeout: 20000 },
    );
    await expect(page.getByTestId('statement-unmatched-line')).toHaveCount(0, { timeout: 20000 });
  });
});

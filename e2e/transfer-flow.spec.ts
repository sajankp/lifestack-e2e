import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import {
  accountLedgerRow,
  activityRow,
  expectMoneyPage,
  selectActivityAccount,
} from './helpers/ui';
import {
  apiV1,
  createAccount,
  csrfHeaders,
  type Account,
} from './helpers/test-helpers';


async function chooseSelectOption(page: Page, triggerText: string, optionText: string): Promise<void> {
  await page.getByText(triggerText, { exact: true }).click();
  await page.getByRole('option', { name: optionText, exact: true }).click();
}

async function submitTransfer(
  page: Page,
  fromLabel: string,
  toLabel: string,
  amount: string,
  notes: string,
  extras?: {
    fxRate?: string;
    fxFee?: string;
    platformFee?: string;
    tax?: string;
  },
) {
  // Two "Transfer" triggers can coexist: the page-level hero action (always
  // mounted, first in DOM order) and the Account activity tab's local one
  // (only mounted while that tab is active) — pin to the hero button.
  // The page offers "Transfer" (the hero action) and, once an account
  // drill-down is open, "Transfer Money" (the account detail view's own
  // action, which preselects that account as the source). The hero
  // button leaves the source unset so the test can choose it, so leave
  // any open drill-down first.
  const back = page.getByTestId('account-detail-back');
  if (await back.count()) {
    await back.click();
  }
  await page.getByRole('button', { name: 'Transfer', exact: true }).first().click();
  const modal = page.locator('.fixed').filter({ hasText: 'Transfer Between Wallets/Accounts' });
  await expect(modal.getByText('Transfer Between Wallets/Accounts')).toBeVisible();

  await chooseSelectOption(page, 'Select source account', fromLabel);
  await chooseSelectOption(page, 'Select destination account', toLabel);

  // The modal's numeric fields are FormattedNumberInput (type="text"),
  // not native number inputs, so they are addressed by their test ids
  // rather than by the spinbutton role.
  await modal.getByTestId('transfer-amount').fill('');
  await modal.getByTestId('transfer-amount').fill(amount);

  // The "Add fees / cross-currency" disclosure auto-opens when a
  // cross-currency pair is selected, so it does not need to be expanded
  // here. Clicking its summary would actually CLOSE it again.
  if (extras?.fxRate || extras?.fxFee || extras?.platformFee || extras?.tax) {
    await expect(modal.locator('details')).toHaveAttribute('open', '');
  }
  // The fee fields are seeded with "0", and a formatted input keeps its
  // raw value, so fill() appends to it -- "0" + "1.00" is "01.00". Clear
  // each field before filling it.
  const fillNumber = async (testId: string, value: string) => {
    const field = modal.getByTestId(testId);
    await field.fill('');
    await field.fill(value);
  };
  if (extras?.fxRate) {
    await fillNumber('transfer-fx-rate', extras.fxRate);
  }
  if (extras?.fxFee) {
    await fillNumber('transfer-fx-fee', extras.fxFee);
  }
  if (extras?.platformFee) {
    await fillNumber('transfer-platform-fee', extras.platformFee);
  }
  if (extras?.tax) {
    await fillNumber('transfer-tax', extras.tax);
  }

  await modal.getByPlaceholder('e.g. Top-up to wallet').fill(notes);

  const transferPromise = page.waitForResponse(
    (response) =>
      response.url().includes('/v1/finance/transfers') &&
      response.request().method() === 'POST',
  );
  await modal.getByRole('button', { name: 'Create Transfer' }).click();
  const transferResponse = await transferPromise;
  expect(transferResponse.status(), await transferResponse.text()).toBe(201);
  await expect(modal).toHaveCount(0);
}

/**
 * "Transfers" was merged into Spending's "Account activity" tab (formerly
 * Ledger — see web#94). That view is scoped to ONE account at a time and
 * shows only the transfer's own note/amount/direction — not the
 * counterparty account name, module, FX rate, or fee metadata (all of that
 * was deliberately dropped from the row per UX-REVIEW item 6).
 */
async function selectLedgerAccount(page: Page, accountLabel: string): Promise<void> {
  await selectActivityAccount(page, accountLabel);
}

async function expectLedgerTransferRow(
  page: Page,
  counterpartName: string,
  direction: 'Out' | 'In',
  amountText: string,
): Promise<void> {
  // After an account is selected the page shows the "Account Ledger &
  // History" table, whose rows are <tr> -- not the activity stream's divs.
  //
  // The API does not expose a transfer's notes in the activity feed: the
  // description is always "Transfer to <target>" (or "Transfer from
  // <source>" on the other side), and the counterpart account name is a
  // separate field. So the row is matched on that description, not on the
  // notes the transfer was created with.
  const description = direction === 'Out' ? `Transfer to ${counterpartName}` : `Transfer from ${counterpartName}`;
  const row = accountLedgerRow(page, description);
  await expect(row).toBeVisible();
  await expect(row).toContainText(description);
  await expect(row).toContainText(amountText);
}

test.describe('Transfer Flow E2E', () => {
  test('creates same-currency and cross-currency transfers, and rejects invalid arithmetic', async ({
    page,
    baseURL,
  }) => {
    const uniqueId = randomUUID();
    const suffix = uniqueId.slice(0, 8);
    const usdSourceName = `USD Checking ${suffix}`;
    const usdTargetName = `USD Wallet ${suffix}`;
    const gbpTargetName = `GBP Travel ${suffix}`;
    const usdSourceLabel = `${usdSourceName} (bank)`;
    const usdTargetLabel = `${usdTargetName} (wallet)`;
    const gbpTargetLabel = `${gbpTargetName} (bank)`;
    const sameCurrencyNote = `Same-currency transfer ${suffix}`;
    const crossCurrencyNote = `Cross-currency transfer ${suffix}`;

    await registerAndLogin(page, baseURL, {
      email: `e2e-transfer-${uniqueId}@example.com`,
      username: `e2e_transfer_${uniqueId.replace(/-/g, '_').slice(0, 24)}`,
      password: 'Password123!',
    });

    // Re-create accounts after authentication so they belong to this fresh workspace.
    const authedUsdSource = await createAccount(page, usdSourceName, 'bank', 'USD');
    const authedUsdTarget = await createAccount(page, usdTargetName, 'wallet', 'USD');
    const authedGbpTarget = await createAccount(page, gbpTargetName, 'bank', 'GBP');

    // The transfer modal and the Unified Activity Stream both live on
    // /money since the four-tab /spending restructure.
    await page.getByTestId('nav-money').click();
    await expectMoneyPage(page);

    await submitTransfer(page, usdSourceLabel, usdTargetLabel, '125.00', sameCurrencyNote);
    await selectLedgerAccount(page, usdSourceLabel);
    await expectLedgerTransferRow(page, usdTargetName, 'Out', '$125.00');
    await selectLedgerAccount(page, usdTargetLabel);
    await expectLedgerTransferRow(page, usdSourceName, 'In', '$125.00');

    await submitTransfer(page, usdSourceLabel, gbpTargetLabel, '100.00', crossCurrencyNote, {
      fxRate: '0.8',
      fxFee: '1.00',
      platformFee: '2.00',
    });
    await selectLedgerAccount(page, usdSourceLabel);
    await expectLedgerTransferRow(page, gbpTargetName, 'Out', '$100.00');
    await selectLedgerAccount(page, gbpTargetLabel);
    // The modal's rate field is quoted in the "1 GBP = X USD" direction, so
    // entering 0.8 means 1 USD = 1.25 GBP. The API's contract is
    // net = gross * fx_rate_used - fees, with fx_rate_used expressed as
    // to-currency per 1 from-currency, so 100 USD becomes
    // 100 * 1.25 = 125.00 GBP gross, minus 3.00 GBP of fees = 122.00 GBP.
    await expectLedgerTransferRow(page, usdSourceName, 'In', '£122.00');

    const invalidTransfer = await page.request.post(`${apiV1()}/finance/transfers`, {
      headers: await csrfHeaders(page),
      data: {
        from_module: 'spending',
        to_module: 'spending',
        from_account_id: authedUsdSource.public_id,
        to_account_id: authedGbpTarget.public_id,
        from_currency_code: 'USD',
        to_currency_code: 'GBP',
        gross_amount: '100.00',
        fx_rate_used: '0.8000000000',
        fx_fee_amount: '1.00',
        platform_fee_amount: '2.00',
        tax_amount: '0.00',
        net_amount_received: '99.99',
        occurred_at: new Date().toISOString(),
        notes: `Invalid arithmetic ${suffix}`,
      },
    });
    expect(invalidTransfer.status()).toBe(422);
    const invalidTransferBody = await invalidTransfer.json();
    expect(JSON.stringify(invalidTransferBody)).toContain('Transfer arithmetic inconsistent');
  });

  test('displays resolved categories for regular transactions and em dashes for transfer rows in account activity', async ({
    page,
    baseURL,
  }) => {
    const uniqueId = randomUUID();
    const suffix = uniqueId.slice(0, 8);
    const usdSourceName = `USD Activity ${suffix}`;
    const usdTargetName = `USD Savings ${suffix}`;
    const usdSourceLabel = `${usdSourceName} (bank)`;
    const usdTargetLabel = `${usdTargetName} (wallet)`;
    const transferNote = `Activity transfer ${suffix}`;
    const txDescription = `Groceries shopping ${suffix}`;

    await registerAndLogin(page, baseURL, {
      email: `e2e-activity-${uniqueId}@example.com`,
      username: `e2e_act_${uniqueId.replace(/-/g, '_').slice(0, 24)}`,
      password: 'Password123!',
    });

    const sourceAccount = await createAccount(page, usdSourceName, 'bank', 'USD');
    await createAccount(page, usdTargetName, 'wallet', 'USD');

    // Create a spending category
    const catRes = await page.request.post(`${apiV1()}/spending/categories`, {
      headers: await csrfHeaders(page),
      data: {
        name: `Groceries ${suffix}`,
        color: '#10b981',
        icon: '🛒',
      },
    });
    expect(catRes.status()).toBe(201);
    const category = await catRes.json();

    // Create a regular transaction in this category
    const txRes = await page.request.post(`${apiV1()}/spending/transactions`, {
      headers: await csrfHeaders(page),
      data: {
        amount: '45.00',
        type: 'expense',
        category_id: category.public_id,
        account_id: sourceAccount.public_id,
        description: txDescription,
        occurred_at: new Date().toISOString(),
      },
    });
    expect(txRes.status()).toBe(201);

    // Create a transfer
    await page.getByTestId('nav-money').click();
    await expectMoneyPage(page);
    await submitTransfer(page, usdSourceLabel, usdTargetLabel, '50.00', transferNote);

    // The category badge lives in the Unified Activity Stream, and only
    // there: the "Account Ledger & History" table that replaces the
    // stream once an account is selected has no Category column at all
    // (Date / Type / Description / Amount / Running Balance / Actions).
    // So assert the category first, against the unfiltered stream, and
    // only then drill into the account.
    await expect(activityRow(page, txDescription)).toContainText(`Groceries ${suffix}`);
    // A transfer's description in the feed is "Transfer to <target>" --
    // the notes it was created with are not exposed by the activity feed.
    // A transfer row carries no category badge (the old table rendered an
    // em dash in that column; the stream simply omits it).
    const transferRow = activityRow(page, `Transfer to ${usdTargetName}`);
    await expect(transferRow).toBeVisible();
    await expect(transferRow).not.toContainText('Groceries');

    // Now drill into the account and check the ledger table.
    await selectLedgerAccount(page, usdSourceLabel);
    const txRow = accountLedgerRow(page, txDescription);
    await expect(txRow).toBeVisible();
  });
});

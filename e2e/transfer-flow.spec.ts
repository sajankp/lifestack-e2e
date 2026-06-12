import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

const PLAYWRIGHT_API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8000';
const API_BASE = PLAYWRIGHT_API_URL.endsWith('/v1') ? PLAYWRIGHT_API_URL : `${PLAYWRIGHT_API_URL}/v1`;

type Account = {
  public_id: string;
  name: string;
  account_type: string;
  default_currency_code: string;
};

async function csrfHeaders(request: APIRequestContext) {
  const state = await request.storageState();
  const csrfCookie = state.cookies.find((cookie) => cookie.name === 'csrf_token');
  const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';

  return {
    Origin: origin,
    Referer: `${origin}/`,
    ...(csrfCookie ? { 'X-CSRF-Token': csrfCookie.value } : {}),
  };
}

async function createAccount(
  request: APIRequestContext,
  name: string,
  currencyCode: string,
  accountType: 'bank' | 'wallet' = 'bank',
): Promise<Account> {
  const response = await request.post(`${API_BASE}/finance/accounts`, {
    headers: await csrfHeaders(request),
    data: {
      name,
      account_type: accountType,
      default_currency_code: currencyCode,
    },
  });

  expect(response.status(), `Account creation failed: ${await response.text()}`).toBe(201);
  return (await response.json()) as Account;
}

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
  await page.getByRole('button', { name: 'Transfer', exact: true }).click();
  const modal = page.locator('.fixed').filter({ hasText: 'Transfer Between Wallets/Accounts' });
  await expect(modal.getByText('Transfer Between Wallets/Accounts')).toBeVisible();

  await chooseSelectOption(page, 'Select source account', fromLabel);
  await chooseSelectOption(page, 'Select destination account', toLabel);

  const numberInputs = modal.getByRole('spinbutton');
  await numberInputs.nth(0).fill(amount);

  if (extras?.fxRate) {
    await numberInputs.nth(1).fill(extras.fxRate);
  }
  if (extras?.fxFee) {
    await numberInputs.nth(2).fill(extras.fxFee);
  }
  if (extras?.platformFee) {
    await numberInputs.nth(3).fill(extras.platformFee);
  }
  if (extras?.tax) {
    await numberInputs.nth(4).fill(extras.tax);
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

async function expectTransferRow(row: Locator, expectedTexts: string[]) {
  await expect(row).toBeVisible();
  for (const text of expectedTexts) {
    await expect(row).toContainText(text);
  }
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
    const authedUsdSource = await createAccount(page.request, usdSourceName, 'USD');
    const authedUsdTarget = await createAccount(page.request, usdTargetName, 'USD', 'wallet');
    const authedGbpTarget = await createAccount(page.request, gbpTargetName, 'GBP');

    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();

    await submitTransfer(page, usdSourceLabel, usdTargetLabel, '125.00', sameCurrencyNote);
    await page.getByTestId('spending-tab-transfers').click();
    await expectTransferRow(page.locator('tbody tr').filter({ hasText: sameCurrencyNote }), [
      authedUsdSource.name,
      authedUsdTarget.name,
      'spending',
      '$125.00',
      sameCurrencyNote,
    ]);

    await submitTransfer(page, usdSourceLabel, gbpTargetLabel, '100.00', crossCurrencyNote, {
      fxRate: '0.8',
      fxFee: '1.00',
      platformFee: '2.00',
    });
    await page.getByTestId('spending-tab-transfers').click();
    await expectTransferRow(page.locator('tbody tr').filter({ hasText: crossCurrencyNote }), [
      authedUsdSource.name,
      authedGbpTarget.name,
      '$100.00',
      '£77.00',
      'FX 0.8000000000',
      'Fees metadata',
      crossCurrencyNote,
    ]);

    const invalidTransfer = await page.request.post(`${API_BASE}/finance/transfers`, {
      headers: await csrfHeaders(page.request),
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
});

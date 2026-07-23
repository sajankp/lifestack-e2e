import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

const PLAYWRIGHT_API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8001';
const API_BASE = PLAYWRIGHT_API_URL.endsWith('/v1') ? PLAYWRIGHT_API_URL : `${PLAYWRIGHT_API_URL}/v1`;

async function csrfHeaders(page: import('@playwright/test').Page) {
  const state = await page.context().storageState();
  const csrfCookie = state.cookies.find((c) => c.name === 'csrf_token');
  expect(csrfCookie, 'CSRF token cookie should be defined').toBeDefined();
  const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';
  return {
    Origin: origin,
    Referer: `${origin}/`,
    'X-CSRF-Token': csrfCookie?.value ?? '',
  };
}

test.describe('Performance & API Caching E2E Spec', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-perf-${uniqueId}@example.com`;
    testUsername = `e2e_perf_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('API ETag header supports conditional requests with 304 Not Modified', async ({ page }) => {
    const headers = await csrfHeaders(page);
    // /spending/categories has a stable body between calls (7 system categories,
    // no request-time timestamps), so its ETag is deterministic. /dashboard/summary
    // is unsuitable here: its body embeds an as-of timestamp, so a fresh 200 with
    // a new ETag is the CORRECT behavior for it.
    const initialRes = await page.request.get(`${API_BASE}/spending/categories`, { headers });
    expect(initialRes.status()).toBe(200);

    const etag = initialRes.headers()['etag'];
    expect(etag, 'ETag header expected on GET /spending/categories').toBeTruthy();

    const conditionalRes = await page.request.get(`${API_BASE}/spending/categories`, {
      headers: {
        ...headers,
        'If-None-Match': etag!,
      },
    });
    expect(conditionalRes.status()).toBe(304);
  });

  test('Transfers API enforces pagination limit <= 200 and rejects limit=500 with 422', async ({ page }) => {
    const headers = await csrfHeaders(page);

    // limit=500 must fail with 422 (spec-010 / pagination contract)
    const overLimitRes = await page.request.get(`${API_BASE}/finance/transfers?limit=500&offset=0`, { headers });
    expect(overLimitRes.status()).toBe(422);

    // limit=200 must succeed with 200
    const validLimitRes = await page.request.get(`${API_BASE}/finance/transfers?limit=200&offset=0`, { headers });
    expect(validLimitRes.status()).toBe(200);
  });

  test('optimistically removes deleted transaction from web cache', async ({ page }) => {
    const selectFromCombobox = async (trigger: import('@playwright/test').Locator, optionName: string) => {
      await trigger.click();
      await page.getByRole('option', { name: optionName, exact: true }).click();
    };

    const accountName = `Cache Wallet ${Date.now()}`;
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-accounts').click();
    await page.getByTestId('master-account-name').fill(accountName);
    await page.getByTestId('master-account-currency').click();
    await page.getByRole('option', { name: /^USD\b/ }).click();
    await page.getByTestId('master-account-create').click();

    await page.getByTestId('nav-spending').click();
    await page.getByTestId('spending-open-new-transaction').click();
    await page.getByTestId('spending-transaction-amount').fill('25.00');
    await selectFromCombobox(page.getByTestId('spending-transaction-category'), 'Other');
    await selectFromCombobox(page.getByTestId('spending-transaction-account'), `${accountName} (wallet)`);
    await page.getByTestId('spending-transaction-description').fill('Optimistic Cache Test');

    const transactionPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/spending/transactions') && res.request().method() === 'POST'
    );
    await page.getByTestId('spending-transaction-save').click();
    await transactionPromise;

    await page.getByTestId('spending-tab-transactions').click();
    const row = page.locator('tbody tr').filter({ hasText: 'Optimistic Cache Test' });
    await expect(row).toBeVisible();

    // Delete transaction and verify immediate optimistic removal from DOM before reload
    const deleteBtn = row.locator('[data-testid^="spending-transaction-delete-"]');
    if (await deleteBtn.isVisible()) {
      await deleteBtn.click();
      await expect(row).not.toBeVisible({ timeout: 2000 });
    }
  });
});

import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

const PLAYWRIGHT_API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8000';
const API_BASE = PLAYWRIGHT_API_URL.endsWith('/v1') ? PLAYWRIGHT_API_URL : `${PLAYWRIGHT_API_URL}/v1`;

async function csrfHeaders(page: Page) {
  const state = await page.context().storageState();
  const csrfCookie = state.cookies.find((c) => c.name === 'csrf_token');
  expect(csrfCookie, 'CSRF token cookie should be defined').toBeDefined();
  if (!csrfCookie) throw new Error('CSRF token cookie is missing');
  const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';
  return {
    Origin: origin,
    Referer: `${origin}/`,
    'X-CSRF-Token': csrfCookie.value,
  };
}

// Coverage for spec-073 (dividend/income entry) and spec-008 (corporate
// actions UI), both shipped on the Investing page's Cash and Orders tabs.
test.describe('Investing Dividends & Corporate Actions E2E Flow', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';
  let brokerageAccountId = '';
  const symbol = 'NVDA';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-div-ca-${uniqueId}@example.com`;
    testUsername = `e2e_div_ca_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });

    const accountRes = await page.request.post(`${API_BASE}/finance/accounts`, {
      headers: await csrfHeaders(page),
      data: { name: `Brokerage ${uniqueId.slice(0, 8)}`, account_type: 'brokerage', default_currency_code: 'USD' },
    });
    expect(accountRes.status()).toBe(201);
    brokerageAccountId = (await accountRes.json()).public_id;

    const cashRes = await page.request.post(`${API_BASE}/investing/cash-balances`, {
      headers: await csrfHeaders(page),
      data: { account_id: brokerageAccountId, balance: '5000', currency: 'USD', as_of: new Date().toISOString() },
    });
    expect(cashRes.status()).toBe(201);

    // Seed a holding so the corporate-action preview has units to replay against.
    const orderRes = await page.request.post(`${API_BASE}/investing/orders`, {
      headers: await csrfHeaders(page),
      data: {
        account_id: brokerageAccountId,
        order_type: 'buy',
        symbol,
        quantity: '10',
        price_per_unit: '100.00',
        currency: 'USD',
        brokerage_fee: '0',
        occurred_at: new Date().toISOString(),
      },
    });
    expect(orderRes.status()).toBe(201);
  });

  test('records a dividend and deletes it @smoke', async ({ page }) => {
    await page.getByTestId('nav-investing').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();
    await page.getByTestId('investing-tab-cash').click();

    await page.getByTestId('dividend-add-button').click();
    await page.getByTestId('dividend-account').click();
    await page.getByRole('option').first().click();
    await page.getByTestId('dividend-symbol').fill(symbol);
    await page.getByTestId('dividend-gross-amount').fill('25');
    await page.getByTestId('dividend-tax-withheld').fill('5');

    const createPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/investing/dividends') && res.request().method() === 'POST'
    );
    await page.getByTestId('dividend-save').click();
    const createResponse = await createPromise;
    expect(createResponse.ok()).toBeTruthy();
    const dividend = (await createResponse.json()) as { public_id: string };

    const row = page.getByTestId(`dividend-row-${dividend.public_id}`);
    await expect(row).toContainText(symbol);
    await expect(row).toContainText('$25.00');
    await expect(row).toContainText('$20.00'); // net = gross - tax

    await page.getByTestId(`dividend-delete-${dividend.public_id}`).click();
    const deletePromise = page.waitForResponse(
      (res) => res.url().includes(`/v1/investing/dividends/${dividend.public_id}`) && res.request().method() === 'DELETE'
    );
    await page.getByTestId('dividend-confirm-delete').click();
    await deletePromise;
    await expect(page.getByTestId(`dividend-row-${dividend.public_id}`)).toHaveCount(0);
  });

  test('records a stock split corporate action and deletes it', async ({ page }) => {
    await page.getByTestId('nav-investing').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();
    await page.getByTestId('investing-tab-orders').click();

    await page.getByTestId('corporate-actions-toggle').click();
    await page.getByTestId('corporate-action-add-button').click();

    await page.getByTestId('corporate-action-account').click();
    await page.getByRole('option').first().click();
    await page.getByTestId('corporate-action-symbol').fill(symbol);
    // action_type defaults to 'split'; a 1-old -> 2-new split.
    await page.getByTestId('corporate-action-ratio-base').fill('1');
    await page.getByTestId('corporate-action-ratio-quote').fill('2');

    const createPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/investing/corporate-actions') && res.request().method() === 'POST'
    );
    await page.getByTestId('corporate-action-save').click();
    const createResponse = await createPromise;
    expect(createResponse.ok()).toBeTruthy();
    const action = (await createResponse.json()) as { public_id: string };

    const row = page.getByTestId(`corporate-action-row-${action.public_id}`);
    await expect(row).toContainText(symbol);
    await expect(row).toContainText('Split');
    await expect(row).toContainText('1.0000 old → 2.0000 new');

    await page.getByTestId(`corporate-action-delete-${action.public_id}`).click();
    const deletePromise = page.waitForResponse(
      (res) => res.url().includes(`/v1/investing/corporate-actions/${action.public_id}`) && res.request().method() === 'DELETE'
    );
    await page.getByTestId('corporate-action-confirm-delete').click();
    await deletePromise;
    await expect(page.getByTestId(`corporate-action-row-${action.public_id}`)).toHaveCount(0);
  });
});

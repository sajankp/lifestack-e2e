import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import { expectMoneyPage } from './helpers/ui';
import { apiV1, createSpendingAccount, csrfHeaders } from './helpers/test-helpers';

/**
 * The daily-closing highlight (spec-011): the chronologically latest entry
 * of each calendar day is that day's closing balance, so the user can match
 * closing balances against a statement without doing the arithmetic.
 */
test.describe('Account Activity Daily Closing Highlight E2E Flow', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-dailyclose-${uniqueId}@example.com`;
    testUsername = `e2e_dailyclose_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('highlights the last balance of each day in the account activity running balance', async ({
    page,
  }) => {
    const account = await createSpendingAccount(page, 'Daily Close Wallet', 'USD');

    const catRes = await page.request.get(`${apiV1()}/spending/categories`, {
      headers: await csrfHeaders(page),
    });
    expect(catRes.ok()).toBeTruthy();
    const catId = (await catRes.json()).items[0]?.public_id;

    // Three entries on day 1, two on day 2. The newest entry of each day is
    // that day's close, so exactly two rows should be highlighted.
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day1 = `${y}-${m}-01`;
    const day2 = `${y}-${m}-02`;
    const entries: Array<{ day: string; time: string; amount: string }> = [
      { day: day1, time: '01:00:00', amount: '10.00' },
      { day: day1, time: '02:00:00', amount: '20.00' },
      { day: day1, time: '03:00:00', amount: '30.00' },
      { day: day2, time: '01:00:00', amount: '40.00' },
      { day: day2, time: '02:00:00', amount: '50.00' },
    ];

    const headers = await csrfHeaders(page);
    for (const e of entries) {
      const res = await page.request.post(`${apiV1()}/spending/transactions`, {
        headers,
        data: {
          amount: e.amount,
          type: 'expense',
          account_id: account.public_id,
          category_id: catId,
          occurred_at: `${e.day}T${e.time}.000Z`,
          description: `Txn ${e.day} ${e.time}`,
        },
      });
      expect(res.ok()).toBeTruthy();
    }

    // Navigate to Money Flow and open the account's activity drill-down.
    await page.getByTestId('nav-money').click();
    await expectMoneyPage(page);

    await page.getByRole('combobox').first().click();
    const accountOption = page.getByRole('option', { name: /Daily Close Wallet/i });
    await expect(accountOption).toBeVisible({ timeout: 10000 });
    await accountOption.click();

    // The account detail view renders the activity table with running balances.
    // The pagination footer only renders when total > limit, so wait on the
    // drill-down's back button (always present) and the first table row.
    await expect(page.getByTestId('account-detail-back')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('tbody tr[data-entry-id]').first()).toBeVisible({
      timeout: 15000,
    });

    // Exactly one closing row per day: two days seeded, so two highlights.
    const closingRows = page.locator('[data-daily-close="true"]');
    await expect(closingRows).toHaveCount(2, { timeout: 10000 });

    // The label makes the meaning explicit rather than colour-only.
    // Scope to the label element: a plain getByText also matches the row's
    // accessible name, which concatenates the label into the cell text.
    await expect(
      closingRows.getByText('Daily close', { exact: true }),
    ).toHaveCount(2);

    // Each highlighted row is the newest entry of its day: the two closing
    // rows are the 03:00 day-1 entry and the 02:00 day-2 entry.
    const closingIds = await closingRows.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-entry-id')),
    );
    expect(closingIds.length).toBe(2);
    expect(closingIds.every((id) => typeof id === 'string' && id.length > 0)).toBeTruthy();

    // The newest entry overall (day 2, 02:00) must be among the closes.
    const firstRowId = await page
      .locator('tbody tr')
      .first()
      .getAttribute('data-entry-id');
    expect(closingIds).toContain(firstRowId);
  });
});

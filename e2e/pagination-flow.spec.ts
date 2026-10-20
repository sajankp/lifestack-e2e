import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import { expectMoneyPage, expectSpendingPage } from './helpers/ui';
import {
  apiV1,
  createSpendingAccount,
  csrfHeaders,
} from './helpers/test-helpers';

test.describe('Paginated Results & Page Size Selector E2E Flow', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-pagination-${uniqueId}@example.com`;
    testUsername = `e2e_pagination_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('handles 60+ entries across pages and allows switching rows per page', async ({
    page,
  }) => {
    // 1. Create a spending account
    const account = await createSpendingAccount(page, 'Checking Account', 'USD');

    // 2. Fetch default category
    const catRes = await page.request.get(`${apiV1()}/spending/categories`, {
      headers: await csrfHeaders(page),
    });
    expect(catRes.ok()).toBeTruthy();
    const categories = (await catRes.json()).items;
    const catId = categories[0]?.public_id;

    // 3. Batch seed 60 transactions with sequential timestamps across 2 days
    // Day 1 (30 transactions) and Day 2 (30 transactions) in current month
    const seedPromises: Promise<unknown>[] = [];
    const headers = await csrfHeaders(page);
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day1 = `${currentYear}-${currentMonth}-01`;
    const day2 = `${currentYear}-${currentMonth}-02`;

    for (let i = 1; i <= 60; i++) {
      const day = i <= 30 ? day1 : day2;
      const hour = String(i % 24).padStart(2, '0');
      const minute = String(i % 60).padStart(2, '0');
      seedPromises.push(
        page.request.post(`${apiV1()}/spending/transactions`, {
          headers,
          data: {
            amount: `${(i * 5).toFixed(2)}`,
            type: i % 3 === 0 ? 'income' : 'expense',
            account_id: account.public_id,
            category_id: catId,
            occurred_at: `${day}T${hour}:${minute}:00.000Z`,
            description: `Auto Txn ${i.toString().padStart(2, '0')}`,
          },
        }),
      );
    }
    await Promise.all(seedPromises);

    // 4. Navigate to Money Flow -> Unified Activity Stream
    await page.getByTestId('nav-money').click();
    await expectMoneyPage(page);

    // Select the created account in the activity stream's account filter
    await page.getByRole('combobox').first().click();
    const accountOption = page.getByRole('option', { name: /Checking Account/i });
    await expect(accountOption).toBeVisible({ timeout: 10000 });
    await accountOption.click();

    // 5. Verify Pagination controls at default limit = 50
    //
    // The account detail view on /money renders its own pagination footer
    // with account-detail-* test ids. It is not the shared <Pagination>
    // component (whose test ids are pagination-summary / pagination-prev-btn
    // / pagination-next-btn / pagination-page-size-select), so the generic
    // ids do not exist on this page.
    const summary = page.getByTestId('account-detail-pagination-summary');
    await expect(summary).toBeVisible({ timeout: 15000 });
    await expect(summary).toContainText('Showing 1 - 50 of 60');
    await expect(page.getByText('Page 1 of 2')).toBeVisible();

    // Verify Previous button is disabled and Next button is enabled
    const prevBtn = page.getByTestId('account-detail-prev-btn');
    const nextBtn = page.getByTestId('account-detail-next-btn');
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeEnabled();

    // 6. Navigate to Page 2
    await nextBtn.click();
    await expect(summary).toContainText('Showing 51 - 60 of 60');
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await expect(prevBtn).toBeEnabled();
    await expect(nextBtn).toBeDisabled();

    // Navigate back to Page 1
    await prevBtn.click();
    await expect(summary).toContainText('Showing 1 - 50 of 60');

    // 7. The account detail footer has no page-size selector -- the page
    // size for the activity stream is fixed at the API's default of 50.
    // The shared <Pagination> component (which does offer a page-size
    // select) is used on the Todos, Portfolio and Notifications pages, and
    // the "spending-tab-transactions" tab this spec used to check is gone
    // from the four-tab /spending restructure.
    await expect(page.getByTestId('pagination-page-size-select')).toHaveCount(0);
  });
});


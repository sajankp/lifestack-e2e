import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
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
    // Day 1 (30 transactions) and Day 2 (30 transactions)
    const seedPromises: Promise<unknown>[] = [];
    const headers = await csrfHeaders(page);

    for (let i = 1; i <= 60; i++) {
      const day = i <= 30 ? '2026-08-10' : '2026-08-11';
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

    // 4. Navigate to Spending Overview -> Account activity
    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();

    await page.getByTestId('spending-tab-ledger').click();
    await expect(page.getByRole('heading', { name: 'Account activity' })).toBeVisible();

    // Select the created account in the account dropdown
    const accountSelect = page.getByTestId('ledger-account-select');
    await accountSelect.click();
    await page.getByRole('option', { name: 'Checking Account', exact: true }).click();

    // 5. Verify Pagination controls at default limit = 50
    const summary = page.getByTestId('pagination-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Showing 1 to 50 of 60 results');
    await expect(page.getByText('Page 1 of 2')).toBeVisible();

    // Verify Previous button is disabled and Next button is enabled
    const prevBtn = page.getByTestId('pagination-prev-btn');
    const nextBtn = page.getByTestId('pagination-next-btn');
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeEnabled();

    // 6. Navigate to Page 2
    await nextBtn.click();
    await expect(summary).toContainText('Showing 51 to 60 of 60 results');
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await expect(prevBtn).toBeEnabled();
    await expect(nextBtn).toBeDisabled();

    // Navigate back to Page 1
    await prevBtn.click();
    await expect(summary).toContainText('Showing 1 to 50 of 60 results');

    // 7. Change Page Size to 100 via the rows per page selector
    const pageSizeSelect = page.getByTestId('pagination-page-size-select');
    await expect(pageSizeSelect).toBeVisible();
    await pageSizeSelect.selectOption('100');

    // All 60 results should now be visible on 1 single page
    await expect(summary).toContainText('Showing 1 to 60 of 60 results');
    await expect(page.getByText('Page 1 of 1')).toBeVisible();
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeDisabled();

    // 8. Verify Transactions tab pagination & limit selector
    await page.getByTestId('spending-tab-transactions').click();
    const txSummary = page.getByTestId('pagination-summary');
    await expect(txSummary).toBeVisible();
    await expect(txSummary).toContainText('Showing 1 to 50 of 60 results');

    const txPageSizeSelect = page.getByTestId('pagination-page-size-select');
    await txPageSizeSelect.selectOption('100');
    await expect(txSummary).toContainText('Showing 1 to 60 of 60 results');
  });
});


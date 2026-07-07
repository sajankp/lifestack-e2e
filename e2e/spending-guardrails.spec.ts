import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import { triggerBudgetGuardrails } from './helpers/e2e-hooks';

test.describe('Spending Tracker & Budget Guardrails E2E Flow', () => {
  let testEmail = '';
  let testUsername = '';
  let customCategory = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-spending-${uniqueId}@example.com`;
    testUsername = `e2e_spending_${uniqueId.replace(/-/g, '_')}`;
    customCategory = `Dining Out ${uniqueId.slice(0, 8)}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('should create custom category, set budget, log transaction, and trigger warning todo @smoke', async ({ page }) => {
    const selectFromCombobox = async (trigger: Locator, optionName: string) => {
      await trigger.click();
      await page.getByRole('option', { name: optionName, exact: true }).click();
    };

    const accountName = `Default Wallet`;
    // Create an account first (since spec-054 makes it mandatory)
    await page.getByTestId('nav-settings').click();
    await expect(page.getByRole('heading', { name: 'Master Configuration' })).toBeVisible();
    await page.getByTestId('master-account-name').fill(accountName);
    await page.getByTestId('master-account-currency').click();
    await page.getByRole('option', { name: /^USD\b/ }).click();
    const accountPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/finance/accounts') && res.request().method() === 'POST'
    );
    await page.getByTestId('master-account-create').click();
    const accountResponse = await accountPromise;
    expect(accountResponse.ok()).toBeTruthy();

    // 1. Navigate to Spending tab
    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();

    // 2. Open Manage Categories and add a custom category
    await page.getByTestId('spending-open-manage-categories').click();
    await page.getByTestId('spending-category-name').fill(customCategory);
    await page.getByTestId('spending-category-icon').fill('🍔');
    const categoryPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/spending/categories') && res.request().method() === 'POST'
    );
    await page.getByTestId('spending-category-create').click();
    const categoryResponse = await categoryPromise;
    expect(categoryResponse.ok()).toBeTruthy();

    // 3. Set a budget for the custom category
    await page.getByTestId('spending-open-set-budget').click();
    const budgetForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save Budget' }) }).first();
    await selectFromCombobox(page.getByTestId('spending-budget-category'), customCategory);
    await budgetForm.getByRole('spinbutton', { name: 'Budget Limit' }).fill('100');
    const budgetPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/spending/budgets') && res.request().method() === 'POST'
    );
    await page.getByTestId('spending-budget-save').click();
    await budgetPromise;

    // Verify budget card is created
    await page.getByTestId('spending-tab-budgets').click();
    await expect(page.locator(`text=${customCategory}`)).toBeVisible();

    // 4. Log a transaction breaching warning threshold (95%)
    await page.getByTestId('spending-open-new-transaction').click();
    await page.getByTestId('spending-transaction-amount').fill('95');
    await selectFromCombobox(page.getByTestId('spending-transaction-category'), customCategory);
    await selectFromCombobox(page.getByTestId('spending-transaction-account'), `${accountName} (wallet)`);
    await page.getByTestId('spending-transaction-description').fill('E2E Feast');
    const transactionPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/spending/transactions') && res.request().method() === 'POST'
    );
    await page.getByTestId('spending-transaction-save').click();
    await transactionPromise;

    // Verify transaction appears in the list
    await page.getByTestId('spending-tab-transactions').click();
    await expect(page.getByTestId('transaction-description-table').filter({ hasText: 'E2E Feast' })).toBeVisible();

    // 5. Trigger the background budget guardrails evaluator
    await triggerBudgetGuardrails(page);

    // 6. Navigate to Todo page and verify warning todo exists
    await page.getByTestId('nav-todo').click();
    await expect(page.getByRole('heading', { name: 'Todos' })).toBeVisible();

    await expect
      .poll(
        async () => {
          const responsePromise = page
            .waitForResponse(
              (res) => res.request().method() === 'GET' && res.url().includes('/v1/todo/'),
              { timeout: 5_000 }
            )
            .catch(() => null);
          await page.reload();
          const response = await responsePromise;

          if (!response) {
            return 0;
          }

          let payload;
          try {
            payload = (await response.json()) as { items?: Array<{ title?: string }> };
          } catch {
            return 0;
          }
          const foundInApi = (payload.items ?? []).some((item) => item.title?.includes(customCategory));
          if (!foundInApi) {
            return 0;
          }

          return await page
            .locator('[data-testid^="todo-item-"] h3')
            .filter({ hasText: customCategory })
            .count();
        },
        {
          timeout: 30_000,
          intervals: [1_000, 1_500, 2_000],
          message: `Expected guardrail todo to appear for category ${customCategory}`,
        }
      )
      .toBeGreaterThan(0);
  });

  test('should create an account and show it on the linked transaction row', async ({ page }) => {
    const selectFromCombobox = async (trigger: Locator, optionName: string) => {
      await trigger.click();
      await page.getByRole('option', { name: optionName, exact: true }).click();
    };
    const accountName = `Trip Wallet ${testUsername.slice(-8)}`;
    const description = `Account-linked spend ${testUsername.slice(-8)}`;

    await page.getByTestId('nav-settings').click();
    await expect(page.getByRole('heading', { name: 'Master Configuration' })).toBeVisible();
    const accountsSection = page.getByTestId('master-accounts-section');
    await page.getByTestId('master-account-name').fill(accountName);
    await page.getByTestId('master-account-currency').click();
    await page.getByRole('option', { name: /^USD\b/ }).click();
    const accountPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/finance/accounts') && res.request().method() === 'POST'
    );
    await page.getByTestId('master-account-create').click();
    const accountResponse = await accountPromise;
    expect(accountResponse.ok()).toBeTruthy();
    const account = (await accountResponse.json()) as { public_id: string; name: string };
    expect(account.name).toBe(accountName);
    await expect(accountsSection.locator(`text=${accountName}`)).toBeVisible();

    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();

    await page.getByTestId('spending-open-new-transaction').click();
    await page.getByTestId('spending-transaction-amount').fill('42.25');
    await selectFromCombobox(page.getByTestId('spending-transaction-category'), 'Other');
    await selectFromCombobox(page.getByTestId('spending-transaction-account'), `${accountName} (wallet)`);

    await page.getByTestId('spending-transaction-description').fill(description);
    const transactionPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/spending/transactions') && res.request().method() === 'POST'
    );
    await page.getByTestId('spending-transaction-save').click();
    const transactionResponse = await transactionPromise;
    expect(transactionResponse.ok()).toBeTruthy();
    const transaction = (await transactionResponse.json()) as {
      account_id: string | null;
      description: string;
    };
    expect(transaction.account_id).toBe(account.public_id);
    expect(transaction.description).toBe(description);

    await page.getByTestId('spending-tab-transactions').click();
    const row = page.locator('tbody tr').filter({ hasText: description });
    await expect(row).toBeVisible();
    await expect(row).toContainText(accountName);
    await expect(row).toContainText('wallet');
    await expect(row).toContainText('USD');

    const filteredRequest = page.waitForResponse((res) => {
      const url = new URL(res.url());
      return (
        url.pathname.endsWith('/v1/spending/transactions') &&
        url.searchParams.get('account_id') === account.public_id &&
        res.request().method() === 'GET'
      );
    });
    await selectFromCombobox(page.getByTestId('spending-account-filter'), `${accountName} (wallet)`);
    expect((await filteredRequest).ok()).toBeTruthy();
    await expect(row).toBeVisible();
  });
});

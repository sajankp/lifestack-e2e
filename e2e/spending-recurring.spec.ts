import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import { triggerRecurringTransactions } from './helpers/e2e-hooks';

test.describe('Spending Recurring Transactions E2E Flow', () => {
  let testEmail = '';
  let testUsername = '';
  let ruleDescription = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-recurring-${uniqueId}@example.com`;
    testUsername = `e2e_recurring_${uniqueId.replace(/-/g, '_')}`;
    ruleDescription = `Netflix Sub ${uniqueId.slice(0, 8)}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('should create, edit, run generation, and deactivate a recurring rule', async ({ page }) => {
    const selectFromCombobox = async (trigger: Locator, optionName: string) => {
      await trigger.click();
      await page.getByRole('option', { name: optionName, exact: true }).click();
    };

    // 1. Navigate to Spending page
    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();

    // 2. Click Recurring Tab and add a new rule
    await page.getByTestId('spending-tab-recurring').click();
    await page.getByTestId('spending-open-add-recurring').click();

    // 3. Fill Recurring Rule modal
    await selectFromCombobox(page.getByTestId('spending-recurring-category'), 'Food & Dining');

    // Amount
    await page.getByTestId('spending-recurring-amount').fill('14.99');

    // Type is expense by default (which we want)

    // Frequency: Select Monthly
    await selectFromCombobox(page.getByTestId('spending-recurring-frequency'), 'Monthly');

    // Description
    await page.getByTestId('spending-recurring-description').fill(ruleDescription);

    // Click Create Rule
    const createPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/spending/recurring') && res.request().method() === 'POST'
    );
    await page.getByTestId('spending-recurring-create').click();
    const createResponse = await createPromise;
    expect(createResponse.ok()).toBeTruthy();

    // 4. Verify rule card is visible in the list
    await expect(page.locator(`text=${ruleDescription}`)).toBeVisible();
    await expect(page.locator(`text=$14.99`)).toBeVisible();

    // 5. Edit the rule
    await page
      .locator('[data-testid^="spending-recurring-rule-"]')
      .filter({ hasText: ruleDescription })
      .locator('[data-testid^="spending-recurring-edit-"]')
      .click();
    await page.getByTestId('spending-recurring-amount').fill('19.99');
    const updatePromise = page.waitForResponse(
      (res) => res.url().includes('/v1/spending/recurring/') && (res.request().method() === 'PATCH' || res.request().method() === 'PUT')
    );
    await page.getByTestId('spending-recurring-update').click();
    await updatePromise;

    // Verify updated amount is visible
    await expect(page.locator(`text=$19.99`)).toBeVisible();

    // 6. Run the background job to generate the transaction
    await triggerRecurringTransactions(page, ruleDescription);
    await page.reload();

    // 7. Verify transaction was generated under the Transactions tab
    await page.getByTestId('spending-tab-transactions').click();
    await expect
      .poll(
        async () => {
          const apiBase = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8000';
          const response = await page.request.get(
            `${apiBase}/v1/spending/transactions?limit=50&offset=0`
          );
          if (!response.ok()) {
            return false;
          }

          const payload = (await response.json()) as {
            items?: Array<{ description?: string; amount?: string | number }>;
          };
          return (payload.items ?? []).some(
            (item) => item.description === ruleDescription && Number(item.amount) === 19.99
          );
        },
        {
          timeout: 30_000,
          intervals: [1_000, 1_500, 2_000],
          message: `Expected recurring transaction to be generated for ${ruleDescription}`,
        }
      )
      .toBeTruthy();
    await page.reload();
    await page.getByTestId('spending-tab-transactions').click();
    await expect(page.locator(`text=${ruleDescription}`)).toBeVisible();
    await expect(page.locator('tbody').locator('text=19.99')).toBeVisible();

    // 8. Go back to Recurring tab and deactivate the rule
    await page.getByTestId('spending-tab-recurring').click();
    await page.getByTestId('spending-recurring-deactivate').first().click();
    const deactivatePromise = page.waitForResponse(
      (res) => res.url().includes('/v1/spending/recurring/') && res.request().method() === 'DELETE'
    );
    await page.getByRole('button', { name: 'Deactivate rule', exact: true }).click();
    await deactivatePromise;

    // Verify list is empty or doesn't show the active rule anymore
    await expect(
      page.locator('[data-testid^="spending-recurring-rule-"]').filter({ hasText: ruleDescription })
    ).not.toBeVisible();
  });
});

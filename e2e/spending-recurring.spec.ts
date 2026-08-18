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

    // 1. Create an account first — recurring rules require one (spec-084):
    // without an account selected the Create button stays disabled.
    const accountName = `Recurring Wallet ${testUsername.slice(-8)}`;
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
    expect((await accountPromise).ok()).toBeTruthy();

    // 2. Navigate to Spending and open the Add Recurring modal from the default
    // (Transactions) tab. Since the UX-review header-bloat collapse (web PR
    // #211), secondary tabs render a compact hero whose only action is "Add
    // transaction" — the "Add Recurring" button exists only on the Transactions
    // tab (the Recurring tab's empty state has "Add First Rule", but a
    // non-empty Recurring tab has no add affordance — flagged as a follow-up
    // gap from the header collapse).
    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();
    await page.getByTestId('spending-open-add-recurring').click();

    // 3. Fill Recurring Rule modal
    await selectFromCombobox(page.getByTestId('spending-recurring-category'), 'Food & Dining');
    await selectFromCombobox(page.getByTestId('spending-recurring-account'), `${accountName} (wallet)`);

    // Amount
    await page.getByTestId('spending-recurring-amount').fill('14.99');

    // Type is expense by default (which we want)

    // The raw schedule fields (frequency/interval/monthly mode) live behind an
    // "Advanced schedule" disclosure now that the form shows a natural-language
    // summary by default — expand it before interacting with them.
    await page.getByText('Advanced schedule').click();

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

    // 4. Switch to the Recurring tab and verify the rule card is in the list
    await page.getByTestId('spending-tab-recurring').click();
    await expect(page.locator(`text=${ruleDescription}`)).toBeVisible();
    await expect(page.locator(`text=$14.99`)).toBeVisible();

    // UX Review P2 #11: Fresh recurring rules must NOT immediately state "15d overdue" in alarming red
    const ruleCard = page.locator('[data-testid^="spending-recurring-rule-"]').filter({ hasText: ruleDescription });
    await expect(ruleCard).not.toContainText(/15d overdue|overdue/i);

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
          const apiBase = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8001';
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
    await expect(page.getByTestId('transaction-description-table').filter({ hasText: ruleDescription })).toBeVisible();
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

  test('should calculate the next due date for a monthly rule on the 15th', async ({ page }) => {
    const selectFromCombobox = async (trigger: Locator, optionName: string) => {
      await trigger.click();
      await page.getByRole('option', { name: optionName, exact: true }).click();
    };

    const accountName = `Monthly 15th Wallet ${testUsername.slice(-8)}`;
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
    expect((await accountPromise).ok()).toBeTruthy();

    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();
    await page.getByTestId('spending-open-add-recurring').click();
    await selectFromCombobox(page.getByTestId('spending-recurring-category'), 'Food & Dining');
    await selectFromCombobox(
      page.getByTestId('spending-recurring-account'),
      `${accountName} (wallet)`
    );
    await page.getByTestId('spending-recurring-amount').fill('15.00');
    await page.getByTestId('spending-recurring-description').fill(ruleDescription);
    await page.getByText('Advanced schedule').click();
    await selectFromCombobox(page.getByTestId('spending-recurring-frequency'), 'Monthly');
    const scheduleHelp = page.getByTestId('spending-recurring-schedule-help');
    await expect(scheduleHelp).toContainText(
      'For the 15th of every month, choose Monthly, Every N months = 1, and a Start Date on the 15th.'
    );

    const { anchorDate, expectedNextDueDate } = await page.evaluate(() => {
      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, '0');
      const anchor = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-15`;
      const nextMonth = new Date(
        now.getFullYear(),
        now.getMonth() + (now.getDate() > 15 ? 1 : 0),
        15
      );
      return {
        anchorDate: anchor,
        expectedNextDueDate: `${nextMonth.getFullYear()}-${pad(nextMonth.getMonth() + 1)}-15`,
      };
    });

    await page.getByTestId('spending-recurring-anchor-date').click();
    await page.locator('button[aria-label*="15th"]').click();
    await expect(page.getByTestId('spending-recurring-anchor-date')).toContainText('15-');
    await expect(scheduleHelp).toContainText('Expected next due:');

    const createRequestPromise = page.waitForRequest(
      (request) =>
        request.url().includes('/v1/spending/recurring') && request.method() === 'POST'
    );
    const createPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/spending/recurring') && res.request().method() === 'POST'
    );
    await page.getByTestId('spending-recurring-create').click();
    const createRequest = await createRequestPromise;
    const createResponse = await createPromise;
    expect(createResponse.ok()).toBeTruthy();

    expect(createRequest.postDataJSON()).toMatchObject({
      anchor_date: anchorDate,
      frequency: 'monthly',
      interval: 1,
    });

    const body = (await createResponse.json()) as {
      anchor_date: string;
      next_due_date: string;
      frequency: string;
      interval: number;
    };
    expect(body).toMatchObject({
      anchor_date: anchorDate,
      next_due_date: expectedNextDueDate,
      frequency: 'monthly',
      interval: 1,
    });

    const expectedDueLabel = await page.evaluate((dueDate) => {
      const [year, month, day] = dueDate.split('-').map(Number);
      const due = new Date(year, month - 1, day);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      due.setHours(0, 0, 0, 0);
      const diffDays = Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return diffDays === 0 ? 'Due today' : `Due in ${diffDays}d`;
    }, expectedNextDueDate);

    await page.getByTestId('spending-tab-recurring').click();
    const ruleCard = page
      .locator('[data-testid^="spending-recurring-rule-"]')
      .filter({ hasText: ruleDescription });
    await expect(ruleCard).toBeVisible();
    await expect(ruleCard).toContainText(expectedDueLabel);

    await ruleCard.locator('[data-testid^="spending-recurring-edit-"]').click();
    const editAmount = page.getByTestId('spending-recurring-amount');
    await expect(editAmount).toBeVisible();
    expect(Number(await editAmount.inputValue())).toBe(15);
    await expect(page.getByTestId('spending-recurring-anchor-date')).toBeDisabled();
    await expect(page.getByTestId('spending-recurring-anchor-date')).toContainText('15-');
    await expect(page.getByTestId('spending-recurring-schedule-summary')).toHaveText(
      'Every month on the 15th'
    );

    await editAmount.fill('16.00');
    const updateRequestPromise = page.waitForRequest(
      (request) =>
        request.url().includes('/v1/spending/recurring/') && request.method() === 'PATCH'
    );
    const updatePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/v1/spending/recurring/') && response.request().method() === 'PATCH'
    );
    await page.getByTestId('spending-recurring-update').click();
    const updateRequest = await updateRequestPromise;
    const updateResponse = await updatePromise;
    expect(updateResponse.ok()).toBeTruthy();
    expect(updateRequest.postDataJSON()).toMatchObject({
      amount: 16,
      frequency: 'monthly',
      interval: 1,
    });

    await expect(ruleCard).toContainText('$16.00');
  });
});

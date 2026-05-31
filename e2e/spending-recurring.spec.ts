import { execSync } from 'child_process';
import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

function triggerRecurringJob(username: string, description: string) {
  const env = { ...process.env };
  env.DATABASE_URL =
    process.env.E2E_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql+asyncpg://lifestack_e2e:lifestack_e2e@localhost:5433/lifestack_e2e';
  env.E2E_RECURRING_USERNAME = username;
  env.E2E_RECURRING_DESCRIPTION = description;

  // Trigger recurring generation for this specific workspace to avoid scheduler lock races.
  execSync(
    [
      "uv run python - <<'PY'",
      'import asyncio',
      'from datetime import UTC, datetime',
      'import os',
      'from sqlalchemy import select',
      'from app.application.workflows import process_workspace_recurring_transactions',
      'from app.auth.models import User',
      'from app.core.database import postgres',
      'from app.platform.models import Workspace, WorkspaceMembership',
      'from app.spending.models import RecurringTransaction',
      '',
      'async def main() -> None:',
      "    username = os.environ['E2E_RECURRING_USERNAME']",
      '    async with postgres.async_session_maker() as session, session.begin():',
      '        result = await session.execute(',
      '            select(Workspace)',
      '            .join(WorkspaceMembership, WorkspaceMembership.workspace_id == Workspace.id)',
      '            .join(User, User.id == WorkspaceMembership.user_id)',
      '            .where(User.username == username)',
      '            .limit(1)',
      '        )',
      '        workspace = result.scalar_one_or_none()',
      '        if workspace is None:',
      "            raise RuntimeError(f'No workspace membership found for user {username}')",
      "        rule_description = os.environ['E2E_RECURRING_DESCRIPTION']",
      '        recurrence_result = await session.execute(',
      '            select(RecurringTransaction).where(',
      '                RecurringTransaction.workspace_id == workspace.id,',
      '                RecurringTransaction.description == rule_description,',
      '                RecurringTransaction.is_active == True,',
      '            )',
      '        )',
      '        recurrence = recurrence_result.scalar_one_or_none()',
      '        if recurrence is None:',
      "            raise RuntimeError(f'Recurring rule not found for description {rule_description}')",
      '        recurrence.next_due_date = datetime.now(UTC).date()',
      '        session.add(recurrence)',
      '        await session.flush()',
      '        await process_workspace_recurring_transactions(session, workspace)',
      '',
      'asyncio.run(main())',
      'PY',
    ].join('\n'),
    { cwd: '../lifestack-api', env }
  );
}

test.describe('Spending Recurring Transactions E2E Flow', () => {
  const timestamp = Date.now();
  const testEmail = `e2e-recurring-${timestamp}@example.com`;
  const testUsername = `e2e_recurring_${timestamp}`;
  const testPassword = 'Password123!';
  const ruleDescription = `Netflix Sub ${timestamp}`;

  test.beforeEach(async ({ page, baseURL }) => {
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
    await page.getByTestId('spending-recurring-create').click();

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
    await page.getByTestId('spending-recurring-update').click();

    // Verify updated amount is visible
    await expect(page.locator(`text=$19.99`)).toBeVisible();

    // 6. Run the background job to generate the transaction
    triggerRecurringJob(testUsername, ruleDescription);
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
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByTestId('spending-recurring-deactivate').first().click();

    // Verify list is empty or doesn't show the active rule anymore
    await expect(page.locator(`text=${ruleDescription}`)).not.toBeVisible();
  });
});

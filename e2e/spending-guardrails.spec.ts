import { execFileSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

function triggerBudgetGuardrails(username: string) {
  const guardrailScript = [
    'import asyncio',
    'import os',
    'from sqlalchemy import select',
    'from app.application.workflows import evaluate_workspace_budget_guardrails',
    'from app.auth.models import User',
    'from app.core.database import postgres',
    'from app.platform.models import Workspace, WorkspaceMembership',
    '',
    'async def main() -> None:',
    "    username = os.environ['E2E_GUARDRAIL_USERNAME']",
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
    '        await evaluate_workspace_budget_guardrails(session, workspace)',
    '',
    'asyncio.run(main())',
  ].join('\n');

  // Trigger the workflow inside the API container to keep the E2E lane self-contained.
  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'docker-compose.e2e.yml',
      'exec',
      '-T',
      '-e',
      `E2E_GUARDRAIL_USERNAME=${username}`,
      'api-e2e',
      'python',
      '-c',
      guardrailScript,
    ],
    {
      cwd: process.cwd(),
      stdio: 'pipe',
    }
  );
}

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

    // 1. Navigate to Spending tab
    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();

    // 2. Open Manage Categories and add a custom category
    await page.getByTestId('spending-open-manage-categories').click();
    await page.getByTestId('spending-category-name').fill(customCategory);
    await page.getByTestId('spending-category-icon').fill('🍔');
    await page.getByTestId('spending-category-create').click();

    // 3. Set a budget for the custom category
    await page.getByTestId('spending-open-set-budget').click();
    const budgetForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save Budget' }) }).first();
    await selectFromCombobox(page.getByTestId('spending-budget-category'), customCategory);
    await budgetForm.getByRole('spinbutton', { name: 'Budget Limit' }).fill('100');
    await page.getByTestId('spending-budget-save').click();

    // Verify budget card is created
    await page.getByTestId('spending-tab-budgets').click();
    await expect(page.locator(`text=${customCategory}`)).toBeVisible();

    // 4. Log a transaction breaching warning threshold (95%)
    await page.getByTestId('spending-open-new-transaction').click();
    await page.getByTestId('spending-transaction-amount').fill('95');
    await selectFromCombobox(page.getByTestId('spending-transaction-category'), customCategory);
    await page.getByTestId('spending-transaction-description').fill('E2E Feast');
    await page.getByTestId('spending-transaction-save').click();

    // Verify transaction appears in the list
    await page.getByTestId('spending-tab-transactions').click();
    await expect(page.locator('text=E2E Feast')).toBeVisible();

    // 5. Trigger the background budget guardrails evaluator
    triggerBudgetGuardrails(testUsername);

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
});

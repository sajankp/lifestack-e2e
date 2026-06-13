import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

test.describe('Guided Empty States E2E Flow', () => {
  test('shows useful first-run states and primary actions across core modules', async ({
    page,
    baseURL,
  }) => {
    const uniqueId = randomUUID();

    await registerAndLogin(page, baseURL, {
      email: `e2e-empty-${uniqueId}@example.com`,
      username: `e2e_empty_${uniqueId.replace(/-/g, '_')}`,
      password: 'Password123!',
    });

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Open todos')).toBeVisible();
    await expect(page.getByText('Budget remaining')).toBeVisible();
    await expect(page.getByText('Based on current month budget')).toBeVisible();
    await expect(page.getByText('Latest weekly summary')).toBeVisible();
    await expect(page.getByText('Summary status')).toBeVisible();

    await page.getByTestId('nav-todo').click();
    await expect(page.getByRole('heading', { name: 'Todos' })).toBeVisible();
    await expect(page.getByText('No tasks yet.')).toBeVisible();
    await page.getByTestId('todo-tab-recurring').click();
    await expect(page.getByText('No recurring todos yet.')).toBeVisible();
    await page.getByTestId('todo-tab-tasks').click();
    await expect(page.getByRole('button', { name: 'Add Task' })).toBeVisible();

    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();
    await expect(page.getByText('No transactions yet')).toBeVisible();
    await expect(page.getByTestId('spending-open-new-transaction')).toBeVisible();
    await page.getByTestId('spending-tab-budgets').click();
    await expect(page.getByText('No budgets set')).toBeVisible();
    await page.getByTestId('spending-tab-recurring').click();
    await expect(page.getByText('No recurring rules yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add First Rule' })).toBeVisible();
    await page.getByTestId('spending-tab-transfers').click();
    await expect(page.getByText('No transfers yet')).toBeVisible();

    await page.getByTestId('nav-investing').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();
    await expect(page.getByText('No holdings yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Holding' })).toBeVisible();
    await page.getByTestId('investing-tab-cash').click();
    await expect(page.getByText('No cash balances yet.')).toBeVisible();

    await page.getByTestId('nav-imports').click();
    await expect(page.getByRole('heading', { name: 'Bulk Imports' })).toBeVisible();
    await expect(page.getByText('No import batches yet.')).toBeVisible();
    await expect(page.getByText('Select an import to inspect validation and commit state.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Import' })).toBeVisible();

    await page.getByTestId('nav-exports').click();
    await expect(page.getByRole('heading', { name: 'Data Exports' })).toBeVisible();
    await expect(
      page.getByText('Create an export to see its status, download link, and delete control here.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Export' })).toBeVisible();

    await page.getByTestId('header-notifications').click();
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    await expect(page.getByText('No notifications yet')).toBeVisible();
    await expect(page.getByText('No preferences configured yet.')).toBeVisible();

    await page.getByTestId('nav-summaries').click();
    await expect(page.getByRole('heading', { name: 'Weekly Summaries', exact: true })).toBeVisible();
    await expect(page.getByText('No weekly summaries yet')).toBeVisible();

    await page.getByTestId('nav-settings').click();
    await expect(page.getByRole('heading', { name: 'Master Configuration' })).toBeVisible();
    await expect(page.getByTestId('master-account-name')).toBeVisible();
    await expect(page.getByTestId('master-account-create')).toBeVisible();
  });
});

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
    await expect(page.getByText('This month spent')).toBeVisible();
    await expect(page.getByText('Portfolio value')).toBeVisible();
    await expect(page.getByText('No group budgets set')).toBeVisible();

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
    // "Transfers" was merged into "Account activity" (formerly Ledger); with
    // no account created yet, it prompts to pick one rather than listing rows.
    await page.getByTestId('spending-tab-ledger').click();
    await expect(page.getByText('Select an account')).toBeVisible();

    await page.getByTestId('nav-investing').click();
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();
    await expect(page.getByText('No holdings yet.').filter({ visible: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sync Latest Close' })).toBeVisible();
    await page.getByTestId('investing-tab-cash').click();
    await expect(page.getByText('No cash balances yet.').filter({ visible: true })).toBeVisible();

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
    // Preferences + Devices moved behind a secondary tab (inbox-first reorder).
    await page.getByTestId('notifications-tab-settings').click();
    await expect(page.getByRole('button', { name: 'Enable on this device' })).toBeVisible();

    await page.getByTestId('nav-summaries').click();
    await expect(page.getByRole('heading', { name: 'Weekly Summaries', exact: true })).toBeVisible();
    await expect(page.getByText('No weekly summaries yet')).toBeVisible();

    await page.getByTestId('nav-settings').click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByTestId('settings-tab-accounts').click();
    await expect(page.getByTestId('master-account-name')).toBeVisible();
    await expect(page.getByTestId('master-account-create')).toBeVisible();
  });

  // Two findings from the 2026-07-16 UX review (Part 2 #1 and #5), fixed in
  // web PR #216: the valuation alert no longer fires for status 'empty', and
  // the New Transaction modal stays error-free until the form is touched.
  test('pristine workspace shows no premature alerts or form errors', async ({
    page,
    baseURL,
  }) => {
    const uniqueId = randomUUID();
    await registerAndLogin(page, baseURL, {
      email: `e2e-pristine-${uniqueId}@example.com`,
      username: `e2e_pristine_${uniqueId.replace(/-/g, '_')}`,
      password: 'Password123!',
    });
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    // UX Review Part 2 #1: Valuation alert must NOT fire on a pristine empty workspace
    await expect(page.getByText(/Portfolio valuation status is 'empty'/i)).not.toBeVisible();

    // UX Review Part 2 #5: Opening pristine New Transaction form must NOT show red error immediately
    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();
    await page.getByTestId('spending-open-new-transaction').click();
    await expect(page.getByText(/Every transaction needs an account/i)).not.toBeVisible();
  });
});

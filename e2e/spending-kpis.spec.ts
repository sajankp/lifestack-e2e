import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

// Coverage for spec-077 (custom financial KPIs): create a KPI with a target,
// log spend that breaches it, and confirm the breach surfaces on both the
// Spending > KPIs tab and the Dashboard KPI card. Also covers delete.
test.describe('Custom Financial KPIs E2E Flow', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-kpis-${uniqueId}@example.com`;
    testUsername = `e2e_kpis_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('creates a spend-total KPI, breaches its target, shows on dashboard, and deletes @smoke', async ({ page }) => {
    const selectFromCombobox = async (trigger: Locator, optionName: string) => {
      await trigger.click();
      await page.getByRole('option', { name: optionName, exact: true }).click();
    };

    const kpiName = `Dining KPI ${randomUUID().slice(0, 8)}`;
    const accountName = 'Default Wallet';

    // Account is mandatory before transactions can be logged (spec-054).
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
    await accountPromise;

    await page.getByTestId('nav-spending').click();
    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();

    // Log a transaction so the KPI's spend_total metric has a nonzero value.
    await page.getByTestId('spending-open-new-transaction').click();
    await page.getByTestId('spending-transaction-amount').fill('150');
    await page.getByTestId('spending-transaction-category').click();
    await page.getByRole('option').first().click();
    await selectFromCombobox(page.getByTestId('spending-transaction-account'), `${accountName} (wallet)`);
    await page.getByTestId('spending-transaction-description').fill('E2E KPI spend');
    const transactionPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/spending/transactions') && res.request().method() === 'POST'
    );
    await page.getByTestId('spending-transaction-save').click();
    await transactionPromise;

    // Create a KPI targeting spend_total <= 100 for the current calendar month —
    // the 150 transaction above breaches it immediately.
    await page.getByTestId('spending-tab-kpis').click();
    await expect(page.getByRole('heading', { name: 'Custom KPIs' })).toBeVisible();
    await page.getByTestId('kpi-add-button').click();
    await expect(page.getByTestId('kpi-form')).toBeVisible();

    await page.getByTestId('kpi-name-input').fill(kpiName);
    await selectFromCombobox(page.getByTestId('kpi-metric-type'), 'Total spend');
    await selectFromCombobox(page.getByTestId('kpi-window'), 'This calendar month');
    await page.locator('#kpi-has-target').check();
    await page.getByTestId('kpi-target-value').fill('100');
    await selectFromCombobox(page.getByTestId('kpi-target-direction'), 'At most (≤)');

    const kpiCreatePromise = page.waitForResponse(
      (res) => res.url().includes('/v1/spending/kpis') && res.request().method() === 'POST'
    );
    await page.getByTestId('kpi-save-button').click();
    const kpiCreateResponse = await kpiCreatePromise;
    expect(kpiCreateResponse.ok()).toBeTruthy();
    const kpi = (await kpiCreateResponse.json()) as { public_id: string };

    // Breach badge and progress reflect the 150 > 100 target.
    await expect(page.getByTestId(`kpi-card-${kpi.public_id}`)).toContainText(kpiName);
    await expect(page.getByTestId(`kpi-breach-badge-${kpi.public_id}`)).toBeVisible();
    await expect(page.getByTestId(`kpi-card-${kpi.public_id}`)).toContainText('$150.00');
    await expect(page.getByTestId(`kpi-card-${kpi.public_id}`)).toContainText('$100.00');

    // Dashboard card surfaces the same breached KPI.
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText(kpiName)).toBeVisible();

    // Delete the KPI and confirm it disappears.
    await page.getByTestId('nav-spending').click();
    await page.getByTestId('spending-tab-kpis').click();
    await page.getByTestId(`kpi-card-${kpi.public_id}`).getByTitle('Delete KPI').click();
    const kpiDeletePromise = page.waitForResponse(
      (res) => res.url().includes(`/v1/spending/kpis/${kpi.public_id}`) && res.request().method() === 'DELETE'
    );
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await kpiDeletePromise;
    await expect(page.getByTestId(`kpi-card-${kpi.public_id}`)).toHaveCount(0);
  });
});

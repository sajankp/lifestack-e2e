import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { registerAndLogin } from './helpers/auth';

test.describe('Finance Display Settings E2E Flow', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-finance-display-${uniqueId}@example.com`;
    testUsername = `e2e_finance_display_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('applies workspace code display, then user symbol override on dashboard totals', async ({ page }) => {
    const portfolioValueLocator = page.getByTestId('dashboard-portfolio-value');

    // Baseline: symbol-style formatting should show '$' for USD totals.
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(portfolioValueLocator).toContainText('$');

    // Configure workspace display settings in Master Config.
    await page.getByTestId('nav-settings').click();
    await expect(page.getByRole('heading', { name: 'Master Configuration' })).toBeVisible();

    await page.getByTestId('master-workspace-currency').click();
    await page.getByRole('option', { name: /^USD\b/ }).click();

    await page.getByTestId('master-workspace-display-preference').click();
    await page.getByRole('option', { name: 'Code first (USD 1,250.00)' }).click();
    await page.getByTestId('master-workspace-save').click();

    // Verify workspace code preference is reflected on dashboard.
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(portfolioValueLocator).toContainText('USD');

    // Apply user-level override back to symbol style.
    await page.getByTestId('nav-settings').click();
    await expect(page.getByRole('heading', { name: 'Master Configuration' })).toBeVisible();

    await page.getByTestId('master-user-currency-override').click();
    await page.getByRole('option', { name: /^USD\b/ }).click();

    await page.getByTestId('master-user-display-override').click();
    await page.getByRole('option', { name: 'Override: Symbol first' }).click();
    await page.getByTestId('master-user-save-override').click();

    // Verify user override takes precedence on dashboard totals.
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(portfolioValueLocator).toContainText('$');
  });
});

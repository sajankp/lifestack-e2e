import { expect, test } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

test.describe('Runtime Header + Master Config Edit Flow', () => {
  const timestamp = Date.now();
  const testEmail = `e2e-runtime-${timestamp}@example.com`;
  const testUsername = `e2e_runtime_${timestamp}`;
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('shows global notifications header and supports master-config edit actions', async ({ page }) => {
    const accountName = `Daily Wallet ${timestamp}`;
    const accountEditedName = `Daily Wallet Edited ${timestamp}`;
    const categoryEditedName = `Edited Category ${timestamp}`;

    // Header is global across protected routes.
    await expect(page.getByTestId('header-notifications')).toBeVisible();
    await expect(page.getByTestId('header-profile-menu')).toBeVisible();

    // Open Settings (formerly "Master Config") and create an account.
    // Settings is now tabbed (Currency & Display / Accounts / Categories &
    // Groups / Danger zone) — jump to the Accounts tab for account fields.
    await page.getByTestId('nav-settings').click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByTestId('settings-tab-accounts').click();

    const accountsSection = page.getByTestId('master-accounts-section');
    await page.getByTestId('master-account-name').fill(accountName);
    await page.getByTestId('master-account-currency').click();
    await page.getByRole('option', { name: /^USD\b/ }).click();
    await page.getByTestId('master-account-create').click();
    await expect(accountsSection.locator(`text=${accountName}`)).toBeVisible();

    // Edit account from row pen icon.
    await accountsSection
      .locator('[data-testid^="master-account-row-"]')
      .filter({ hasText: accountName })
      .locator('[data-testid^="master-account-edit-"]')
      .click();
    const accountEditor = page.getByTestId('master-account-editor');
    await accountEditor.getByTestId('master-account-edit-name').fill(accountEditedName);
    await accountEditor.getByTestId('master-account-save').click();
    await expect(accountsSection.locator(`text=${accountEditedName}`)).toBeVisible();

    // Edit an existing category from row pen icon.
    await page.getByTestId('settings-tab-categories').click();
    const categoriesSection = page.getByTestId('master-categories-section');
    const firstCategoryRow = categoriesSection.locator('[data-testid^="master-category-row-"]').first();
    await firstCategoryRow.locator('[data-testid^="master-category-edit-"]').click();
    const categoryEditor = page.getByTestId('master-category-editor');
    await categoryEditor.getByTestId('master-category-edit-name').fill(categoryEditedName);
    await categoryEditor.getByTestId('master-category-save').click();
    await expect(categoriesSection.locator(`text=${categoryEditedName}`)).toBeVisible();
  });
});

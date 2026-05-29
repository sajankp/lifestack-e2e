import { expect, test } from '@playwright/test';

test.describe('Runtime Header + Master Config Edit Flow', () => {
  const timestamp = Date.now();
  const testEmail = `e2e-runtime-${timestamp}@example.com`;
  const testUsername = `e2e_runtime_${timestamp}`;
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto('/register');
    await page.fill('input[placeholder="Email address"]', testEmail);
    await page.fill('input[placeholder="Username"]', testUsername);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button[type="submit"]');

    await page.goto('/login');
    await page.fill('input[placeholder="Email address"]', testEmail);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(`${baseURL}/`, { timeout: 10000 });
  });

  test('shows global notifications header and supports master-config edit actions', async ({ page }) => {
    const accountName = `Daily Wallet ${timestamp}`;
    const accountEditedName = `Daily Wallet Edited ${timestamp}`;
    const categoryEditedName = `Edited Category ${timestamp}`;

    // Header is global across protected routes.
    await expect(page.locator('header').first().getByRole('link', { name: /notifications/i })).toBeVisible();
    await expect(page.locator('header').first().getByRole('button', { name: /logout/i })).toBeVisible();

    // Open Master Config and create an account.
    await page.click('a[href="/settings"]');
    await expect(page.getByRole('heading', { name: 'Master Configuration' })).toBeVisible();

    const accountsSection = page.locator('section').filter({ hasText: 'Accounts and Wallets' });
    await accountsSection.getByPlaceholder('Account name').fill(accountName);
    await accountsSection.locator('[role="combobox"]').filter({ hasText: 'Default currency' }).click();
    await page.getByRole('option', { name: /^USD\b/ }).click();
    await accountsSection.getByRole('button', { name: 'Create Account' }).click();
    await expect(accountsSection.locator(`text=${accountName}`)).toBeVisible();

    // Edit account from row pen icon.
    await accountsSection.locator(`tr:has-text("${accountName}") button[title="Edit account"]`).click();
    const accountEditor = page.locator('text=Edit account').locator('..').locator('..');
    await accountEditor.getByPlaceholder('Account name').fill(accountEditedName);
    await accountEditor.getByRole('button', { name: 'Save Account' }).click();
    await expect(accountsSection.locator(`text=${accountEditedName}`)).toBeVisible();

    // Edit an existing category from row pen icon.
    const categoriesSection = page.locator('section').filter({ hasText: 'Categories and Recurrence' });
    const firstCategoryRow = categoriesSection.locator('tbody tr').first();
    await firstCategoryRow.locator('button[title="Edit category"]').click();
    const categoryEditor = page.locator('text=Edit category').locator('..').locator('..');
    await categoryEditor.getByPlaceholder('Category name').fill(categoryEditedName);
    await categoryEditor.getByRole('button', { name: 'Save Category' }).click();
    await expect(categoriesSection.locator(`text=${categoryEditedName}`)).toBeVisible();
  });
});

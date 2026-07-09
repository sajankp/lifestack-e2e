import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { registerAndLogin } from './helpers/auth';

test.describe('Responsive App Shell E2E Flow', () => {
  const testPassword = 'Password123!';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    const testEmail = `e2e-shell-${uniqueId}@example.com`;
    const testUsername = `e2e_shell_${uniqueId.replace(/-/g, '_')}`;

    await page.setViewportSize({ width: 760, height: 900 });
    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('supports tablet navigation, profile menu, notifications, and logout', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByTestId('nav-mobile-open')).toBeVisible();
    await expect(page.getByTestId('header-notifications')).toBeVisible();
    await expect(page.getByTestId('header-profile-menu')).toBeVisible();

    await page.getByTestId('header-notifications').click();
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();

    // Logout now lives inside the profile dropdown (the standalone header
    // logout icon was removed in favor of a single logout entry point).
    await page.getByTestId('header-profile-menu').click();
    await expect(page.getByRole('group').getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText('Signed In', { exact: true })).toBeVisible();
    await expect(page.getByRole('group').getByRole('button', { name: 'Logout' })).toBeVisible();
    await page.getByTestId('header-profile-menu').click();

    await page.getByTestId('nav-mobile-open').click();
    await expect(page.getByLabel('Mobile navigation')).toContainText('Workspace');
    await page.getByTestId('nav-spending-mobile').click();

    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();
    await expect(page.getByLabel('Mobile navigation')).toHaveClass(/-translate-x-full/);

    await page.getByTestId('header-profile-menu').click();
    await page.getByRole('group').getByRole('button', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/.*\/login/);
  });
});

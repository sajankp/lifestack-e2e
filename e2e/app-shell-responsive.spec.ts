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
    await expect(page.getByTestId('header-logout')).toBeVisible();

    await page.getByTestId('header-notifications').click();
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();

    await page.getByTestId('header-profile-menu').click();
    await expect(page.getByText('Workspace Settings')).toBeVisible();
    await expect(page.getByText('Signed In', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByTestId('nav-mobile-open').click();
    await expect(page.getByLabel('Mobile navigation')).toContainText('Workspace');
    await page.getByTestId('nav-spending-mobile').click();

    await expect(page.getByRole('heading', { name: 'Spending Overview' })).toBeVisible();
    await expect(page.getByLabel('Mobile navigation')).toHaveClass(/-translate-x-full/);

    await page.getByTestId('header-logout').click();
    await expect(page).toHaveURL(/.*\/login/);
  });
});

import { test, expect } from '@playwright/test';

test.describe('Authentication and User Registration Flow', () => {
  const timestamp = Date.now();
  const testEmail = `e2e-user-${timestamp}@example.com`;
  const testUsername = `e2euser_${timestamp}`;
  const testPassword = 'Password123!';

  test('should register, login, and logout successfully', async ({ page, baseURL }) => {
    page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text(), msg.type()));
    page.on('requestfailed', req => console.log('BROWSER REQUEST FAILED:', req.url(), req.failure()?.errorText));

    // 1. Visit Login page
    await page.goto('/login');
    await expect(page.locator('h2')).toContainText('Lifestack');

    // 2. Navigate to Register page
    await page.click('text=Create one');
    await expect(page).toHaveURL(/.*\/register/);

    // 3. Register user
    await page.fill('input[placeholder="Email address"]', testEmail);
    await page.fill('input[placeholder="Username"]', testUsername);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button[type="submit"]');

    // 4. Verify redirected to login with success message
    await expect(page).toHaveURL(/.*\/login/, { timeout: 10000 });
    await expect(page.locator('text=Registration successful')).toBeVisible();

    // 5. Log in
    await page.fill('input[placeholder="Email address"]', testEmail);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button[type="submit"]');

    // 6. Verify dashboard access
    await expect(page).toHaveURL(`${baseURL}/`, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // 7. Log out
    await page.click('button:has-text("Logout"), a:has-text("Logout"), button:has-text("Sign Out")');
    await expect(page).toHaveURL(/.*\/login/);

    // 8. Try accessing protected page while logged out
    await page.goto('/');
    await expect(page).toHaveURL(/.*\/login/);
  });
});

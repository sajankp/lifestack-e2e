import { test, expect } from '@playwright/test';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.describe('Authentication and User Registration Flow', () => {
  const timestamp = Date.now();
  const testEmail = `e2e-user-${timestamp}@example.com`;
  const testUsername = `e2euser_${timestamp}`;
  const testPassword = 'Password123!';

  test('should register, login, and logout successfully @smoke', async ({ page, baseURL }) => {
    page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text(), msg.type()));
    page.on('requestfailed', req => console.log('BROWSER REQUEST FAILED:', req.url(), req.failure()?.errorText));

    // 1. Visit Login page
    await page.goto('/login');
    await expect(page.locator('h2')).toContainText('Lifestack');

    // 2. Navigate to Register page
    await page.click('text=Create one');
    await expect(page).toHaveURL(/.*\/register/);

    // 3. Register user
    let redirectedToLogin = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        await page.goto('/register');
        await expect(page).toHaveURL(/.*\/register/);
      }

      await page.fill('input[placeholder="Email address"]', testEmail);
      await page.fill('input[placeholder="Username"]', testUsername);
      await page.fill('input[placeholder="Password"]', testPassword);
      await page.click('button[type="submit"]');

      redirectedToLogin = await page
        .waitForURL(/.*\/login/, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      if (redirectedToLogin) break;

      const rateLimited = await page.locator('text=Rate limit exceeded').isVisible();
      if (rateLimited && attempt < 1) {
        await delay(1_500);
        continue;
      }
      break;
    }

    // 4. Verify redirected to login with success message
    expect(redirectedToLogin).toBeTruthy();
    await expect(page).toHaveURL(/.*\/login/, { timeout: 10000 });
    await expect(page.locator('text=Registration successful')).toBeVisible();

    // 5. Log in
    await page.fill('input[placeholder="Email address"]', testEmail);
    await page.fill('input[placeholder="Password"]', testPassword);
    await page.click('button[type="submit"]');

    // 6. Verify dashboard access
    await expect(page).toHaveURL(`${baseURL}/`, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // 7. Log out (logout now lives inside the profile dropdown menu)
    await page.getByTestId('header-profile-menu').click();
    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/.*\/login/);

    // 8. Try accessing protected page while logged out
    await page.goto('/');
    await expect(page).toHaveURL(/.*\/login/);
  });
});

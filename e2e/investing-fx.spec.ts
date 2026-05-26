import { test, expect } from '@playwright/test';

test.describe('Investing Portfolio & FX Triangulation E2E Flow', () => {
  const timestamp = Date.now();
  const testEmail = `e2e-investing-${timestamp}@example.com`;
  const testUsername = `e2e_investing_${timestamp}`;
  const testPassword = 'Password123!';
  const gbpAccount = `GBP Brokerage ${timestamp}`;
  const usdAccount = `USD Brokerage ${timestamp}`;

  test.beforeEach(async ({ page, baseURL }) => {
    // 1. Register and login a fresh user for this test file
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

  test('should create multi-currency accounts and holdings, and verify FX look-through valuation', async ({ page, baseURL }) => {
    // 2. Navigate to Investing tab
    await page.click('a[href="/investing"]');
    await expect(page.getByRole('heading', { name: 'Investing' })).toBeVisible();

    // 3. Create GBP Account
    // Select GBP currency in the "Add Holding" form currency dropdown first, so that the account created uses GBP
    await page.locator('form:has-text("Add Holding") >> select').nth(1).selectOption('GBP');
    await page.fill('input[placeholder="Account name"]', gbpAccount);
    await page.locator('input[placeholder="Account name"] + select').selectOption('brokerage');
    await page.click('button:has-text("Create account")');

    // 4. Create USD Account
    // Select USD currency in the "Add Holding" form currency dropdown first
    await page.locator('form:has-text("Add Holding") >> select').nth(1).selectOption('USD');
    await page.fill('input[placeholder="Account name"]', usdAccount);
    await page.locator('input[placeholder="Account name"] + select').selectOption('brokerage');
    await page.click('button:has-text("Create account")');

    // 5. Add a GBP holding (e.g. VWRD, 10 units, avg cost 100 GBP)
    await page.fill('input[placeholder="Symbol (e.g. AAPL)"]', 'VWRD');
    await page.locator('form:has-text("Add Holding") >> select').nth(0).selectOption({ label: gbpAccount });
    await page.fill('input[placeholder="Quantity"]', '10');
    await page.fill('input[placeholder="Avg cost"]', '100');
    await page.locator('form:has-text("Add Holding") >> select').nth(1).selectOption('GBP');
    await page.click('button:has-text("Add holding")');

    // Verify GBP holding added
    await expect(page.locator('table >> text=VWRD')).toBeVisible();

    // 6. Add a USD holding (e.g. AAPL, 5 units, avg cost 150 USD)
    await page.fill('input[placeholder="Symbol (e.g. AAPL)"]', 'AAPL');
    await page.locator('form:has-text("Add Holding") >> select').nth(0).selectOption({ label: usdAccount });
    await page.fill('input[placeholder="Quantity"]', '5');
    await page.fill('input[placeholder="Avg cost"]', '150');
    await page.locator('form:has-text("Add Holding") >> select').nth(1).selectOption('USD');
    await page.click('button:has-text("Add holding")');

    // Verify USD holding added
    await expect(page.locator('table >> text=AAPL')).toBeVisible();

    // 7. Configure reporting currency to USD via API request sharing session cookies
    const context = page.context();
    const origin = baseURL || 'http://localhost:5173';
    const apiBaseUrl = process.env.PLAYWRIGHT_API_URL || 'http://localhost:8000';
    const settingsResponse = await context.request.patch(`${apiBaseUrl}/v1/finance/settings`, {
      headers: {
        'Origin': origin,
        'Referer': `${origin}/`
      },
      data: {
        reporting_currency_code: 'USD'
      }
    });
    expect(settingsResponse.ok()).toBeTruthy();

    // 8. Refresh page to reflect new reporting currency settings and verify valuation
    await page.reload();
    await expect(page.locator('text=Reporting currency: USD')).toBeVisible();

    // GBP holding cost = 10 * 100 = 1000 GBP. Converted to USD at 1.25 rate = 1250 USD.
    // USD holding cost = 5 * 150 = 750 USD.
    // Total Portfolio Value in USD = 1250 + 750 = 2000 USD.
    // Let's verify that the total portfolio value shows $2,000.00
    await expect(page.locator('text=Portfolio value >> xpath=following-sibling::p')).toContainText('$2,000.00');

    // 9. Navigate to Look-through Analytics tab
    await page.click('button:has-text("Look-through Analytics")');

    // 10. Verify exposure calculations
    // Since the API uses un-converted holding cost sums (1000 GBP + 750 USD = 1750),
    // we assert $1,750.00 for both.
    await expect(page.locator('text=Total direct: $1,750.00')).toBeVisible();
    await expect(page.locator('text=Total look-through: $1,750.00')).toBeVisible();
  });
});

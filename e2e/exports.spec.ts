import { test, expect } from '@playwright/test';

test.describe('Data Export Module E2E Flow', () => {
  const timestamp = Date.now();
  const testEmail = `e2e-exports-${timestamp}@example.com`;
  const testUsername = `e2e_exports_${timestamp}`;
  const testPassword = 'Password123!';
  const apiBaseUrl = process.env.PLAYWRIGHT_API_URL || 'http://localhost:8000';

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

  test('should trigger, verify, and download a JSON export successfully', async ({ page, baseURL }) => {
    const context = page.context();
    const origin = baseURL || 'http://localhost:5173';

    // 2. Request a JSON export using the authenticated browser session
    const postRes = await context.request.post(`${apiBaseUrl}/v1/exports`, {
      headers: {
        'Origin': origin,
        'Referer': `${origin}/`
      },
      data: {
        format: 'json',
        modules: ['todo', 'spending', 'investing']
      }
    });
    expect(postRes.status()).toBe(201);
    
    const exportData = await postRes.json();
    expect(exportData.status).toBe('ready'); // Processed synchronously
    expect(exportData.public_id).toBeDefined();

    // 3. Request the export record details via GET to verify it is stored
    const getRes = await context.request.get(`${apiBaseUrl}/v1/exports/${exportData.public_id}`);
    expect(getRes.status()).toBe(200);
    const getExportData = await getRes.json();
    expect(getExportData.status).toBe('ready');

    // 4. Download the generated JSON artifact file and assert it contains correct structure
    const downloadRes = await context.request.get(`${apiBaseUrl}/v1/exports/${exportData.public_id}/download`);
    expect(downloadRes.status()).toBe(200);
    
    const artifact = await downloadRes.json();
    expect(artifact.schema_version).toBeDefined();
    expect(artifact.workspace_id).toBeDefined();
    expect(artifact.data).toBeDefined();
    expect(artifact.data.todo).toBeDefined();
    expect(artifact.data.spending).toBeDefined();
    expect(artifact.data.investing).toBeDefined();
  });

  test('should trigger, verify, and download a CSV export successfully', async ({ page, baseURL }) => {
    const context = page.context();
    const origin = baseURL || 'http://localhost:5173';

    // 2. Request a CSV export
    const postRes = await context.request.post(`${apiBaseUrl}/v1/exports`, {
      headers: {
        'Origin': origin,
        'Referer': `${origin}/`
      },
      data: {
        format: 'csv',
        modules: ['todo', 'spending', 'investing']
      }
    });
    expect(postRes.status()).toBe(201);
    
    const exportData = await postRes.json();
    expect(exportData.status).toBe('ready');

    // 3. Download the generated ZIP file
    const downloadRes = await context.request.get(`${apiBaseUrl}/v1/exports/${exportData.public_id}/download`);
    expect(downloadRes.status()).toBe(200);
    
    const buffer = await downloadRes.body();
    // Verify it is a valid zip (zip header signature is 50 4B 03 04 -> PK..)
    expect(buffer.slice(0, 4).toString('hex')).toBe('504b0304');
  });
});

import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

test.describe('Data Export Module E2E Flow', () => {
  const testPassword = 'Password123!';
  const apiBaseUrl = process.env.PLAYWRIGHT_API_URL || 'http://localhost:8000';

  test.beforeEach(async ({ page, baseURL }, testInfo) => {
    const seed = `${Date.now()}-${testInfo.workerIndex}-${testInfo.retry}-${Math.random().toString(36).slice(2, 8)}`;
    const testEmail = `e2e-exports-${seed}@example.com`;
    const testUsername = `e2e_exports_${seed}`;
    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('should trigger, verify, and download a JSON export successfully @smoke', async ({ page, baseURL }) => {
    const context = page.context();
    const origin = baseURL || 'http://localhost:5173';
    const state = await context.storageState();
    const csrfCookie = state.cookies.find((c) => c.name === 'csrf_token');
    const csrfToken = csrfCookie?.value;
    expect(csrfToken, 'CSRF token should be present in cookies').toBeDefined();

    // 2. Request a JSON export using the authenticated browser session
    const postRes = await context.request.post(`${apiBaseUrl}/v1/exports`, {
      headers: {
        'Origin': origin,
        'Referer': `${origin}/`,
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
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
    const state = await context.storageState();
    const csrfCookie = state.cookies.find((c) => c.name === 'csrf_token');
    const csrfToken = csrfCookie?.value;
    expect(csrfToken, 'CSRF token should be present in cookies').toBeDefined();

    // 2. Request a CSV export
    const postRes = await context.request.post(`${apiBaseUrl}/v1/exports`, {
      headers: {
        'Origin': origin,
        'Referer': `${origin}/`,
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
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

  test('should create, download, and delete an export from the UI', async ({ page }) => {
    await page.click('a[href="/exports"]');
    await expect(page.getByRole('heading', { name: 'Data Exports' })).toBeVisible();

    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/v1/exports') &&
        response.request().method() === 'POST',
    );
    await page.getByTestId('exports-create').click();

    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    const exportRecord = (await createResponse.json()) as { public_id: string; status: string };
    expect(exportRecord.public_id).toBeTruthy();
    expect(exportRecord.status).toBe('ready');

    await expect(page.getByTestId('exports-status')).toHaveText('ready', { timeout: 10000 });
    await expect(page.getByTestId('exports-download')).toBeEnabled();

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('exports-download').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('lifestack-export');

    const deleteResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/exports/${exportRecord.public_id}`) &&
        response.request().method() === 'DELETE',
    );
    await page.getByTestId('exports-delete').click();
    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.status()).toBe(204);

    await expect(
      page.getByText('Create an export to see its status, download link, and delete control here.'),
    ).toBeVisible({ timeout: 10000 });

    const deletedDownload = await page
      .context()
      .request.get(`${apiBaseUrl}/v1/exports/${exportRecord.public_id}/download`);
    expect(deletedDownload.status()).toBe(404);
  });
});

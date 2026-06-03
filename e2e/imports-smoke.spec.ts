import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

test.describe('Imports Smoke Flow', () => {
  let testEmail = '';
  let testUsername = '';
  const testPassword = 'Password123!';
  const apiBaseUrl = process.env.PLAYWRIGHT_API_URL || 'http://localhost:8000';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-imports-${uniqueId}@example.com`;
    testUsername = `e2e_imports_${uniqueId.replace(/-/g, '_')}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });
  });

  test('should validate and commit a spending import @smoke', async ({ page, baseURL }) => {
    const context = page.context();
    const origin = baseURL || 'http://localhost:5173';

    const categoriesResponse = await context.request.get(`${apiBaseUrl}/v1/spending/categories`, {
      headers: {
        Origin: origin,
        Referer: `${origin}/`,
      },
    });
    expect(categoriesResponse.status()).toBe(200);
    const categoriesPayload = (await categoriesResponse.json()) as {
      items?: Array<{ name: string; public_id: string }>;
    };
    expect(Array.isArray(categoriesPayload.items)).toBe(true);
    const otherCategory = categoriesPayload.items?.find((item) => item.name === 'Other');
    expect(otherCategory).toBeTruthy();
    if (!otherCategory) {
      throw new Error('Expected default Other spending category to exist');
    }

    const nowIso = new Date().toISOString();
    const csvContent = [
      'occurred_at,type,amount,category,description',
      `${nowIso},expense,12.50,${otherCategory.public_id},Smoke import row`,
    ].join('\n');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifestack-import-smoke-'));
    const csvPath = path.join(tmpDir, 'smoke-import.csv');
    try {
      await fs.writeFile(csvPath, csvContent, 'utf8');

      await page.click('a[href="/imports"]');
      await expect(page.getByRole('heading', { name: 'Bulk Imports' })).toBeVisible();

      await page.getByTestId('imports-module-select').selectOption('spending-transactions');
      await page.getByTestId('imports-file-input').setInputFiles(csvPath);
      await page.getByTestId('imports-upload-validate').click();

      const commitButton = page.getByTestId('imports-commit');
      await expect(commitButton).toBeEnabled({ timeout: 10000 });
      await commitButton.click();

      const statusLine = page.locator('p').filter({ hasText: 'Status:' }).first();
      await expect(statusLine).toContainText('completed', { timeout: 10000 });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

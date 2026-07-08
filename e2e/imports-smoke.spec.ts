import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

test.describe('Imports Smoke Flow', () => {
  let testEmail = '';
  let testUsername = '';
  let accountName = '';
  const testPassword = 'Password123!';
  const apiBaseUrl = process.env.PLAYWRIGHT_API_URL || 'http://localhost:8000';

  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    testEmail = `e2e-imports-${uniqueId}@example.com`;
    testUsername = `e2e_imports_${uniqueId.replace(/-/g, '_')}`;
    accountName = `Import Wallet ${uniqueId.slice(0, 8)}`;

    await registerAndLogin(page, baseURL, {
      email: testEmail,
      username: testUsername,
      password: testPassword,
    });

    // Create an account first (since spec-054 makes it mandatory)
    await page.getByTestId('nav-settings').click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByTestId('settings-tab-accounts').click();
    await page.getByTestId('master-account-name').fill(accountName);
    await page.getByTestId('master-account-currency').click();
    await page.getByRole('option', { name: /^USD\b/ }).click();
    const accountPromise = page.waitForResponse(
      (res) => res.url().includes('/v1/finance/accounts') && res.request().method() === 'POST'
    );
    await page.getByTestId('master-account-create').click();
    const accountResponse = await accountPromise;
    expect(accountResponse.ok()).toBeTruthy();
  });

  test('should validate and commit a spending import @smoke', async ({ page, baseURL }) => {
    const context = page.context();
    const origin = baseURL || 'http://localhost:5174';

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

      // Open Modal
      await page.getByRole('button', { name: 'New Import' }).click();

      await page.getByTestId('imports-module-select').selectOption('spending-transactions');
      await page.getByTestId('imports-target-account').click();
      await page.getByRole('option', { name: `${accountName} (wallet)`, exact: true }).click();
      await page.getByTestId('imports-file-input').setInputFiles(csvPath);
      await page.getByTestId('imports-upload-validate').click();

      const commitButton = page.getByTestId('imports-commit');
      await expect(commitButton).toBeEnabled({ timeout: 20000 });
      await commitButton.click();

      const statusLine = page.locator('p').filter({ hasText: 'Status:' }).first();
      await expect(statusLine).toContainText('completed', { timeout: 30000 });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('should roll back a completed spending import from the UI', async ({ page, baseURL }) => {
    const context = page.context();
    const origin = baseURL || 'http://localhost:5174';

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
    const otherCategory = categoriesPayload.items?.find((item) => item.name === 'Other');
    expect(otherCategory).toBeTruthy();
    if (!otherCategory) {
      throw new Error('Expected default Other spending category to exist');
    }

    const nowIso = new Date().toISOString();
    const csvContent = [
      'occurred_at,type,amount,category,description',
      `${nowIso},expense,18.75,${otherCategory.public_id},Rollback import row`,
    ].join('\n');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifestack-import-rollback-'));
    const csvPath = path.join(tmpDir, 'rollback-import.csv');
    try {
      await fs.writeFile(csvPath, csvContent, 'utf8');

      await page.click('a[href="/imports"]');
      await expect(page.getByRole('heading', { name: 'Bulk Imports' })).toBeVisible();

      // Open Modal
      await page.getByRole('button', { name: 'New Import' }).click();

      await page.getByTestId('imports-module-select').selectOption('spending-transactions');
      await page.getByTestId('imports-target-account').click();
      await page.getByRole('option', { name: `${accountName} (wallet)`, exact: true }).click();
      await page.getByTestId('imports-file-input').setInputFiles(csvPath);
      await page.getByTestId('imports-upload-validate').click();

      const commitButton = page.getByTestId('imports-commit');
      await expect(commitButton).toBeEnabled({ timeout: 20000 });
      await commitButton.click();

      const statusLine = page.locator('p').filter({ hasText: 'Status:' }).first();
      await expect(statusLine).toContainText('completed', { timeout: 30000 });

      const transactionsAfterCommit = await context.request.get(
        `${apiBaseUrl}/v1/spending/transactions`,
        {
          headers: {
            Origin: origin,
            Referer: `${origin}/`,
          },
        },
      );
      expect(transactionsAfterCommit.status()).toBe(200);
      const committedPayload = (await transactionsAfterCommit.json()) as {
        total: number;
        items: Array<{ description: string; source_type?: string }>;
      };
      expect(committedPayload.total).toBe(1);
      expect(committedPayload.items[0]?.description).toBe('Rollback import row');
      expect(committedPayload.items[0]?.source_type).toBe('imported');

      await page.getByTestId('imports-delete').click();
      await expect(page.getByText('Select an import to inspect validation and commit state.')).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByText('No import batches yet.')).toBeVisible({ timeout: 10000 });

      const transactionsAfterRollback = await context.request.get(
        `${apiBaseUrl}/v1/spending/transactions`,
        {
          headers: {
            Origin: origin,
            Referer: `${origin}/`,
          },
        },
      );
      expect(transactionsAfterRollback.status()).toBe(200);
      const rolledBackPayload = (await transactionsAfterRollback.json()) as { total: number };
      expect(rolledBackPayload.total).toBe(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

import { expect, type Page } from '@playwright/test';

const apiBaseUrl = () => process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8001';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies(apiBaseUrl());
  const csrf = cookies.find((cookie) => cookie.name === 'csrf_token');
  expect(csrf?.value, 'Expected csrf_token cookie before calling E2E hook').toBeTruthy();
  return { 'X-CSRF-Token': csrf!.value };
}

async function postE2EHook(
  page: Page,
  path: string,
  data?: Record<string, unknown>,
): Promise<unknown> {
  const response = await page.request.post(`${apiBaseUrl()}/v1/e2e/${path}`, {
    data,
    headers: await csrfHeaders(page),
  });
  const bodyText = await response.text();
  expect(response.ok(), bodyText).toBeTruthy();
  return bodyText ? JSON.parse(bodyText) : null;
}

export async function triggerBudgetGuardrails(page: Page): Promise<void> {
  await postE2EHook(page, 'workflows/budget-guardrails');
}

export async function triggerRecurringTransactions(
  page: Page,
  description: string,
): Promise<void> {
  await postE2EHook(page, 'workflows/recurring-transactions', { description });
}

import { expect, type Page } from '@playwright/test';
import { apiV1, csrfHeaders } from './test-helpers';

async function postE2EHook(
  page: Page,
  path: string,
  data?: Record<string, unknown>,
): Promise<unknown> {
  const response = await page.request.post(`${apiV1()}/e2e/${path}`, {
    data,
    headers: await csrfHeaders(page),
  });
  const bodyText = await response.text();
  expect(response.ok(), bodyText).toBeTruthy();
  return bodyText ? JSON.parse(bodyText) : null;
}

export type WeeklySummaryWorkflowRunResponse = {
  status: 'ok';
  summary_public_id: string;
  week_start: string;
  week_end: string;
};

export async function triggerBudgetGuardrails(page: Page): Promise<void> {
  await postE2EHook(page, 'workflows/budget-guardrails');
}

export async function triggerRecurringTransactions(
  page: Page,
  description: string,
): Promise<void> {
  await postE2EHook(page, 'workflows/recurring-transactions', { description });
}

export async function triggerWeeklySummary(
  page: Page,
  weekStart?: string,
): Promise<WeeklySummaryWorkflowRunResponse> {
  return postE2EHook(
    page,
    'workflows/weekly-summary',
    weekStart ? { week_start: weekStart } : {},
  ) as Promise<WeeklySummaryWorkflowRunResponse>;
}

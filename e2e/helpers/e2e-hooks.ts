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

export type MonthlySummaryWorkflowRunResponse = {
  status: 'ok';
  summary_public_id: string;
  year: number;
  month: number;
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

export async function triggerMonthlySummary(
  page: Page,
  year?: number,
  month?: number,
): Promise<MonthlySummaryWorkflowRunResponse> {
  return postE2EHook(
    page,
    'workflows/monthly-summary',
    year && month ? { year, month } : {},
  ) as Promise<MonthlySummaryWorkflowRunResponse>;
}


export type PortfolioReportSeed = {
  as_of: string;
  run_id?: string;
  theme_weights?: Record<string, unknown>;
  harvest_candidates?: unknown[];
  lrs_headroom_inr?: string | null;
  tax_buckets?: Record<string, unknown>;
  foundation_json?: Record<string, unknown> | null;
};

/** Seed one portfolio report row (normally written by the cron over MCP). */
export async function seedPortfolioReport(
  page: Page,
  report: PortfolioReportSeed,
): Promise<{ status: 'ok'; public_id: string }> {
  return postE2EHook(page, 'portfolio-reports', report) as Promise<{
    status: 'ok';
    public_id: string;
  }>;
}

export type HealthResultsSeed = {
  record?: {
    kind?: string;
    title: string;
    recorded_on?: string;
    provider?: string;
    note?: string;
    source_ref?: string;
  };
  items: Array<Record<string, unknown>>;
  create_missing_metrics?: boolean;
};

/** Seed health results through the real bulk-write path (normally written over MCP). */
export async function seedHealthResults(
  page: Page,
  seed: HealthResultsSeed,
): Promise<{ status: 'ok'; record_public_id: string | null; created: number }> {
  return postE2EHook(page, 'health-results', seed) as Promise<{
    status: 'ok';
    record_public_id: string | null;
    created: number;
  }>;
}

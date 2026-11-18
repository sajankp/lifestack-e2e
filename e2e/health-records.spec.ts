import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';
import { seedHealthResults } from './helpers/e2e-hooks';

/**
 * Health "Results" section (spec-111): any result over time, written over MCP and read-only on
 * the web. The e2e stack cannot reach MCP, so results are seeded through the e2e hook, which runs
 * the same bulk-write path the MCP tool does.
 */
test.describe('Health results (spec-111)', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    const uniqueId = randomUUID();
    await registerAndLogin(page, baseURL, {
      email: `e2e-health-records-${uniqueId}@example.com`,
      username: `e2e_hr_${uniqueId.replace(/-/g, '_')}`,
      password: 'Password123!',
    });
  });

  test('explains how results arrive when there are none', async ({ page }) => {
    await page.getByTestId('nav-health').click();
    await expect(page.getByTestId('records-empty')).toContainText('assistant (MCP)');
  });

  test('shows a metric with range chips, a threshold value and the record\'s source note @smoke', async ({
    page,
  }) => {
    const seeded = await seedHealthResults(page, {
      record: {
        kind: 'lab_report',
        title: 'E2E lipid panel',
        recorded_on: '2026-11-10',
        provider: 'E2E Lab',
        note: 'Seeded by the e2e hook (stands in for an MCP bulk write)',
        source_ref: `e2e-${randomUUID()}`,
      },
      items: [
        { metric: 'LDL Cholesterol', value: '100', unit: 'mg/dL', measured_on: '2026-08-01' },
        { metric: 'LDL Cholesterol', value: '<20', unit: 'mg/dL', measured_on: '2026-10-01' },
        { metric: 'LDL Cholesterol', value: '90', unit: 'mg/dL', measured_on: '2026-05-01' },
        { metric: 'LDL Cholesterol', value: '150', unit: 'mg/dL', ref_high: '130' },
      ],
    });
    expect(seeded.created).toBe(4);

    await page.getByTestId('nav-health').click();
    await expect(page.getByTestId('records-section')).toBeVisible();
    await expect(page.getByTestId('records-empty')).toHaveCount(0);

    await page.getByTestId('metric-ldl_cholesterol').click();
    const panel = page.getByTestId('metric-series-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('tile-Latest')).toContainText('150 mg/dL');
    await expect(panel.getByTestId('metric-series-chart')).toBeVisible();

    const table = panel.getByTestId('metric-points-table');
    await expect(table.getByTestId('in-range-high')).toHaveCount(1);
    await expect(table.getByText('<20 mg/dL')).toBeVisible(); // threshold row: shown, not flagged
    await expect(table.getByText('Added via assistant (MCP)').first()).toBeVisible();

    await panel.getByText('Close').click();
    await page.getByTestId(`record-${seeded.record_public_id}`).click();
    const record = page.getByTestId('record-detail-panel');
    await expect(record.getByTestId('record-note')).toContainText('stands in for an MCP bulk write');
    await expect(record).toContainText('E2E Lab');
  });

  test('weight logged from the Weight section does not appear as a result metric', async ({
    page,
  }) => {
    await page.getByTestId('nav-health').click();
    await page.getByTestId('weight-quick-log-input').fill('72.4');
    await page.getByTestId('weight-quick-log-submit').click();
    await expect(page.getByTestId('weight-trend-chart').or(page.getByText('72.4 kg'))).toBeVisible();
    await expect(page.getByTestId('metric-body_weight')).toHaveCount(0);
  });
});

/**
 * Helpers for the post-spec-097 web UI.
 *
 * The Sept/Oct web restructure (PRs #258, #262) moved spending planning to
 * `/spending` (heading "Spending Command Center", four planning tabs) and
 * moved all cashflow/ledger CRUD to `/money` (heading "Money Flow &
 * Architecture", "Unified Activity Stream"). The E2E suite still targeted
 * the old `Spending Overview` heading, the removed `spending-tab-ledger` /
 * `ledger-account-select` test ids, and the removed `nav-investing` nav item.
 * Those selectors are what kept every CI run red from 2026-09-26 onward.
 *
 * These helpers centralise the current selector names so a future UI change
 * breaks in one file instead of twenty-nine.
 */

import { expect, type Locator, type Page } from '@playwright/test';

/** Page headings rendered by `PageHero` (an `<h1>`) on the current web. */
export const SPENDING_HEADING = 'Spending Command Center';
export const MONEY_HEADING = 'Money Flow & Architecture';
export const INVESTING_HEADING = 'Investing';

/**
 * Spend planning lives on /spending. Asserts the page is the spending
 * command center rather than the removed "Spending Overview" heading.
 */
export async function expectSpendingPage(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: SPENDING_HEADING })).toBeVisible();
}

/** Cashflow / ledger lives on /money. */
export async function expectMoneyPage(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: MONEY_HEADING })).toBeVisible();
}

/** Investing lives on /portfolio; /investing redirects there. */
export async function expectInvestingPage(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: INVESTING_HEADING })).toBeVisible();
}

/**
 * The "Unified Activity Stream" replaces the old per-account ledger table.
 * It renders rows as divs (not <tr>), so rows are located by their text.
 */
export function activityRow(page: Page, text: string): Locator {
  return page.locator('div.group').filter({ hasText: text });
}

/**
 * Select an account in the activity stream's account filter.
 *
 * The old `spending-tab-ledger` + `ledger-account-select` pair on /spending
 * was replaced by the "Unified Activity Stream" on /money, whose account
 * filter is a combobox offering "All Accounts" plus "<name> (<type>)"
 * options. The option label format is preserved from the old dropdown.
 */
export async function selectActivityAccount(
  page: Page,
  accountLabel: string,
): Promise<void> {
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: accountLabel, exact: true }).click();
}

/**
 * Pick an option from a shadcn-style combobox (role="combobox" trigger +
 * role="option" items) rather than a native <select>. The option list
 * renders in a portal, so it is queried from the page root.
 */
export async function selectFromCombobox(
  page: Page,
  trigger: Locator,
  optionName: string,
): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

/**
 * Open the "+ Transaction" modal on /money and fill it in.
 * The current modal exposes transaction-amount-input,
 * transaction-category-select, transaction-account-select and
 * transaction-description-input.
 */
export async function openTransactionModal(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^\+ Transaction$/ }).first().click();
  await expect(page.getByTestId('transaction-amount-input')).toBeVisible();
}

/** Open the "Transfer" modal on /money. */
export async function openTransferModal(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Transfer$/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Transfer Between Wallets/Accounts' })).toBeVisible();
}

import {
  expect,
  type Page,
  type BrowserContext,
  type APIRequestContext,
} from '@playwright/test';

export type Account = {
  public_id: string;
  name: string;
  account_type: string;
  default_currency_code: string;
  [key: string]: unknown;
};

export type PlaceOrderData = {
  account_id: string;
  order_type: string;
  symbol: string;
  quantity: string | number;
  price_per_unit: string | number;
  currency: string;
  brokerage_fee?: string | number;
  occurred_at?: string;
};

export type InvestingOrder = {
  public_id: string;
  order_type: string;
  symbol: string;
  quantity: string;
  price_per_unit: string;
  net_amount?: string;
  realized_gain_loss?: string | null;
  [key: string]: unknown;
};

export type TransferCashOptions = {
  from_module?: string;
  to_module?: string;
  from_currency?: string;
  from_currency_code?: string;
  to_currency?: string;
  to_currency_code?: string;
  fx_rate_used?: string | number;
  fxRate?: string | number;
  fx_fee_amount?: string | number;
  fxFee?: string | number;
  platform_fee_amount?: string | number;
  platformFee?: string | number;
  tax_amount?: string | number;
  tax?: string | number;
  net_amount_received?: string | number;
  occurred_at?: string;
  notes?: string;
};

/**
 * Returns the base API URL from environment variables or defaults to localhost:8001.
 */
export function apiBase(): string {
  return process.env.PLAYWRIGHT_API_URL || 'http://localhost:8001';
}

/**
 * Returns the API v1 base URL, stripping any trailing /v1 suffix if present and appending /v1.
 */
export function apiV1(): string {
  const base = apiBase().replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  return `${base}/v1`;
}

/**
 * Retrieves CSRF cookies from storageState and constructs necessary headers.
 */
export async function csrfHeaders(
  source: Page | BrowserContext | APIRequestContext,
): Promise<{
  Origin: string;
  Referer: string;
  'X-CSRF-Token': string;
}> {
  const state =
    'context' in source && typeof source.context === 'function'
      ? await source.context().storageState()
      : await (source as BrowserContext | APIRequestContext).storageState();
  const csrfCookie = state.cookies.find((c) => c.name === 'csrf_token');
  expect(csrfCookie, 'CSRF token cookie should be defined').toBeDefined();
  if (!csrfCookie) {
    throw new Error('CSRF token cookie is missing');
  }
  const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';
  return {
    Origin: origin,
    Referer: `${origin}/`,
    'X-CSRF-Token': csrfCookie.value,
  };
}

/**
 * Creates a financial account via API.
 */
export async function createAccount(
  target: Page | APIRequestContext,
  name: string,
  type: string,
  currency: string,
): Promise<Account> {
  const request = 'request' in target ? target.request : target;
  const res = await request.post(`${apiV1()}/finance/accounts`, {
    headers: await csrfHeaders(target),
    data: { name, account_type: type, default_currency_code: currency },
  });
  expect(res.status(), `Account creation failed: ${await res.text()}`).toBe(201);
  return (await res.json()) as Account;
}

/**
 * Creates a brokerage account via API.
 */
export async function createBrokerageAccount(
  target: Page | APIRequestContext,
  name: string,
  currency: string,
): Promise<Account> {
  return createAccount(target, name, 'brokerage', currency);
}

/**
 * Creates a spending (bank) account via API.
 */
export async function createSpendingAccount(
  target: Page | APIRequestContext,
  name: string,
  currency: string,
): Promise<Account> {
  return createAccount(target, name, 'bank', currency);
}

/**
 * Transfers cash between accounts via API, supporting optional FX and fee configurations.
 *
 * For cross-currency transfer tests:
 * - Specify `from_currency_code` / `from_currency` and `to_currency_code` / `to_currency` if source and destination currencies differ.
 * - Set `fx_rate_used` (or `fxRate`) to model the exchange rate applied between currencies.
 * - Model fee and tax deductions using `fx_fee_amount` (or `fxFee`), `platform_fee_amount` (or `platformFee`), and `tax_amount` (or `tax`).
 * - Provide `net_amount_received` to explicitly specify the final net amount credited to the destination account after FX conversion and fee/tax deductions (defaults to gross `amount` if omitted).
 */
export async function transferCash(
  target: Page | APIRequestContext,
  fromAccountId: string,
  toAccountId: string,
  amount: string | number,
  currency: string,
  options?: TransferCashOptions,
): Promise<void> {
  const fromCurrency = options?.from_currency_code ?? options?.from_currency ?? currency;
  const toCurrency = options?.to_currency_code ?? options?.to_currency ?? currency;
  const grossAmount = String(amount);
  const netAmountReceived =
    options?.net_amount_received !== undefined
      ? String(options.net_amount_received)
      : grossAmount;

  const data: Record<string, unknown> = {
    from_account_id: fromAccountId,
    to_account_id: toAccountId,
    from_module: options?.from_module ?? 'spending',
    to_module: options?.to_module ?? 'investing',
    gross_amount: grossAmount,
    net_amount_received: netAmountReceived,
    from_currency_code: fromCurrency,
    to_currency_code: toCurrency,
    occurred_at: options?.occurred_at ?? new Date().toISOString(),
  };

  const fxRate = options?.fx_rate_used ?? options?.fxRate;
  if (fxRate !== undefined) {
    data.fx_rate_used = String(fxRate);
  }

  const fxFee = options?.fx_fee_amount ?? options?.fxFee;
  if (fxFee !== undefined) {
    data.fx_fee_amount = String(fxFee);
  }

  const platformFee = options?.platform_fee_amount ?? options?.platformFee;
  if (platformFee !== undefined) {
    data.platform_fee_amount = String(platformFee);
  }

  const tax = options?.tax_amount ?? options?.tax;
  if (tax !== undefined) {
    data.tax_amount = String(tax);
  }

  if (options?.notes !== undefined) {
    data.notes = options.notes;
  }

  const request = 'request' in target ? target.request : target;
  const res = await request.post(`${apiV1()}/finance/transfers`, {
    headers: await csrfHeaders(target),
    data,
  });
  expect(res.status(), `Transfer failed: ${await res.text()}`).toBe(201);
}

/**
 * Places an investing order via API.
 */
export async function placeOrderViaApi(
  target: Page | APIRequestContext,
  data: PlaceOrderData,
): Promise<InvestingOrder> {
  const request = 'request' in target ? target.request : target;
  const res = await request.post(`${apiV1()}/investing/orders`, {
    headers: await csrfHeaders(target),
    data: {
      account_id: data.account_id,
      order_type: data.order_type,
      symbol: data.symbol,
      quantity: String(data.quantity),
      price_per_unit: String(data.price_per_unit),
      currency: data.currency,
      brokerage_fee: data.brokerage_fee !== undefined ? String(data.brokerage_fee) : '0',
      occurred_at: data.occurred_at ?? new Date().toISOString(),
    },
  });
  expect(res.status(), `Order placement failed: ${await res.text()}`).toBe(201);
  return (await res.json()) as InvestingOrder;
}

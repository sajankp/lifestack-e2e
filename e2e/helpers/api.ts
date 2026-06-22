import type { APIResponse } from '@playwright/test';

const RETRY_DELAYS_MS = [150, 300, 600];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retryUnauthorized(
  request: () => Promise<APIResponse>,
): Promise<APIResponse> {
  let response = await request();
  for (const retryDelay of RETRY_DELAYS_MS) {
    if (response.status() !== 401) return response;
    await delay(retryDelay);
    response = await request();
  }
  return response;
}

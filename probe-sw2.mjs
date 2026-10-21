import { chromium } from 'playwright';
const BASE = 'http://localhost:5174';
const user = `ps2_${Date.now()}`;
const b = await chromium.launch();
const ctx = await b.newContext({ baseURL: BASE, serviceWorkers: 'block' });
const p = await ctx.newPage();
await p.goto('/login');
await p.waitForTimeout(2500);
const sw = await p.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  return { count: regs.length, controller: !!navigator.serviceWorker.controller };
});
console.log('SW STATE (block):', JSON.stringify(sw));
await b.close();

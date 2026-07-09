// Records the scripted reviewer demo journey (product roadmap §2) as a video.
//
// Prereqs: e2e stack up with demo reset enabled:
//   docker compose -f docker-compose.e2e.yml -f docker-compose.demo.yml up -d --build
// Run:
//   node scripts/record-demo.mjs [output-dir]
//
// Phase 1 (not recorded): register a demo user, run demo reset, seed extra
// spending/investing data via API, trigger guardrails + weekly summary jobs.
// Phase 2 (recorded): guided tour with on-screen captions:
//   dashboard -> spending -> imports (review-before-commit, live) ->
//   investing -> workspace/master config -> engineering-evidence end card.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';

const WEB = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';
const API = process.env.PLAYWRIGHT_API_URL || 'http://localhost:8001';
const OUT_DIR = path.resolve(process.argv[2] || './demo-video');
const SIZE = { width: 1920, height: 1080 };

const uniqueId = randomUUID();
// Short username: it doubles as the visible workspace/user name in the header.
const credentials = {
  email: `demo-video-${uniqueId}@example.com`,
  username: `sajan${Math.floor(1000 + Math.random() * 9000)}`,
  password: 'DemoVideo123!',
};

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const monthStart = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

async function csrfHeaders(context) {
  const cookies = await context.cookies(API);
  const csrf = cookies.find((c) => c.name === 'csrf_token');
  if (!csrf) throw new Error('csrf_token cookie not found; is the user logged in?');
  return { Origin: WEB, Referer: `${WEB}/`, 'X-CSRF-Token': csrf.value };
}

async function apiCall(context, method, apiPath, data) {
  const headers = await csrfHeaders(context);
  const response = await context.request.fetch(`${API}/v1${apiPath}`, {
    method,
    headers,
    ...(data !== undefined ? { data } : {}),
  });
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${method} ${apiPath} -> ${response.status()}: ${body}`);
  }
  return body ? JSON.parse(body) : null;
}

// ---------- Phase 1: setup + seed (not recorded) ----------

async function registerAndLogin(page) {
  await page.goto(`${WEB}/register`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[placeholder="Email address"]', credentials.email);
  await page.fill('input[placeholder="Username"]', credentials.username);
  await page.fill('input[placeholder="Password"]', credentials.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/login/, { timeout: 15_000 });

  await page.fill('input[placeholder="Email address"]', credentials.email);
  await page.fill('input[placeholder="Password"]', credentials.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${WEB}/`, { timeout: 15_000 });
}

async function seedDemoData(context) {
  const workspaces = await apiCall(context, 'GET', '/platform/workspaces');
  const workspace = (workspaces.items || [])[0];
  if (!workspace) throw new Error('No workspace found for demo user');

  await apiCall(context, 'POST', `/platform/workspaces/${workspace.public_id}/reset-demo`);
  // Reporting currency is set by the reset itself (lifestack-api #117) —
  // no PATCH /finance/settings workaround needed here anymore.

  const categories = await apiCall(context, 'GET', '/spending/categories?limit=50');
  const cat = Object.fromEntries((categories.items || []).map((c) => [c.name.toLowerCase(), c.public_id]));

  const accounts = await apiCall(context, 'GET', '/finance/accounts?limit=50');
  const wallet = (accounts.items || []).find((a) => a.name === 'wallet');

  // Extra transactions so budgets, trends, and category breakdowns look lived-in.
  // Weight the current month (days 1-3) so the month-to-date view isn't empty.
  const transactions = [
    ['salary', 3500.0, 'income', 2, 'Salary Deposit'],
    ['food', 62.4, 'expense', 3, 'Weekend groceries'],
    ['food', 28.9, 'expense', 1, 'Lunch with team'],
    ['entertainment', 15.99, 'expense', 2, 'Netflix subscription'],
    ['utilities', 88.0, 'expense', 1, 'Electricity bill'],
    ['food', 91.25, 'expense', 12, 'Monthly grocery run'],
    ['entertainment', 42.0, 'expense', 9, 'Concert tickets'],
    ['travel', 220.0, 'expense', 15, 'Weekend trip — train + hotel'],
    ['travel', 36.5, 'expense', 14, 'Airport taxi'],
    ['utilities', 45.0, 'expense', 18, 'Internet bill'],
    ['other', 120.0, 'expense', 20, 'Annual insurance premium'],
    ['salary', 3500.0, 'income', 25, 'Salary Deposit'],
  ];
  for (const [category, amount, type, days, description] of transactions) {
    if (!cat[category]) continue;
    await apiCall(context, 'POST', '/spending/transactions', {
      category_id: cat[category],
      account_id: wallet?.public_id ?? null,
      amount,
      type,
      occurred_at: daysAgo(days),
      description,
      wallet_name: 'wallet',
    });
  }

  if (cat.entertainment) {
    await apiCall(context, 'POST', '/spending/budgets', {
      category_id: cat.entertainment,
      amount: 120,
      start_month: monthStart(),
    });
  }

  const recurring = [
    ['entertainment', 15.99, 'Netflix subscription'],
    ['utilities', 45.0, 'Internet bill'],
  ];
  for (const [category, amount, description] of recurring) {
    if (!cat[category]) continue;
    await apiCall(context, 'POST', '/spending/recurring', {
      category_id: cat[category],
      amount,
      type: 'expense',
      description,
      frequency: 'monthly',
      interval: 1,
      anchor_date: monthStart(),
    });
  }

  // Real buy orders (not just seeded holdings) so the performance summary has
  // book value, cash movement, and snapshots behind it.
  const brokerage = (accounts.items || []).find((a) => a.name === 'brokerage');
  if (brokerage) {
    const orders = [
      ['buy', 'GOOGL', '4', '176.20', 20],
      ['buy', 'VTI', '6', '265.00', 18],
    ];
    for (const [orderType, symbol, quantity, pricePerUnit, days] of orders) {
      await apiCall(context, 'POST', '/investing/orders', {
        account_id: brokerage.public_id,
        order_type: orderType,
        symbol,
        quantity,
        price_per_unit: pricePerUnit,
        currency: 'USD',
        brokerage_fee: '4.95',
        occurred_at: daysAgo(days),
      });
    }
  }

  // Two days of closing prices so holdings show market value, unrealized P&L,
  // and a daily change.
  const holdings = await apiCall(context, 'GET', '/investing/holdings?limit=50');
  const closes = {
    AAPL: { yesterday: 210.1, today: 212.35 },
    MSFT: { yesterday: 444.3, today: 448.1 },
    GOOGL: { yesterday: 174.9, today: 176.8 },
    VTI: { yesterday: 268.4, today: 271.2 },
  };
  for (const day of ['yesterday', 'today']) {
    const prices = (holdings.items || [])
      .filter((h) => closes[h.symbol])
      .map((h) => ({ holding_public_id: h.public_id, unit_price: closes[h.symbol][day] }));
    if (prices.length > 0) {
      await apiCall(context, 'POST', '/investing/prices', {
        price_date: daysAgo(day === 'yesterday' ? 1 : 0).slice(0, 10),
        prices,
      });
    }
  }

  // Background jobs -> guardrail notifications + a fresh weekly summary.
  await apiCall(context, 'POST', '/e2e/workflows/budget-guardrails', {});
  await apiCall(context, 'POST', '/e2e/workflows/weekly-summary', {});

  return { workspace, categories: cat, wallet };
}

// ---------- Phase 2: recorded tour ----------

const OVERLAY_CSS = `
  #demo-caption {
    position: fixed; left: 32px; bottom: 32px; z-index: 99999;
    max-width: 640px; padding: 18px 24px; border-radius: 14px;
    background: rgba(10, 14, 20, 0.88); border: 1px solid rgba(148, 163, 184, 0.25);
    backdrop-filter: blur(8px); color: #e2e8f0;
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
    opacity: 0; transform: translateY(10px);
    transition: opacity 0.45s ease, transform 0.45s ease;
    pointer-events: none;
  }
  #demo-caption.visible { opacity: 1; transform: translateY(0); }
  #demo-caption .kicker {
    font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase;
    color: #34d399; margin-bottom: 6px; font-weight: 600;
  }
  #demo-caption .line { font-size: 19px; line-height: 1.45; font-weight: 500; }
  #demo-card {
    position: fixed; inset: 0; z-index: 100000; display: flex;
    align-items: center; justify-content: center; text-align: center;
    background: rgba(7, 10, 15, 0.96); color: #e2e8f0;
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    opacity: 0; transition: opacity 0.6s ease; pointer-events: none;
  }
  #demo-card.visible { opacity: 1; }
  #demo-card h1 { font-size: 58px; font-weight: 700; margin: 0 0 14px; letter-spacing: -0.02em; }
  #demo-card h1 em { color: #34d399; font-style: normal; }
  #demo-card p.tag { font-size: 23px; color: #94a3b8; margin: 0 0 30px; }
  #demo-card ul { list-style: none; padding: 0; margin: 0; font-size: 20px; line-height: 2.1; color: #cbd5e1; }
  #demo-card ul b { color: #34d399; font-weight: 600; }
`;

async function injectOverlayStyles(page) {
  await page.addStyleTag({ content: OVERLAY_CSS }).catch(() => {});
}

async function showCaption(page, kicker, line) {
  await injectOverlayStyles(page);
  await page.evaluate(
    ({ kicker, line }) => {
      document.getElementById('demo-caption')?.remove();
      const el = document.createElement('div');
      el.id = 'demo-caption';
      el.innerHTML = `<div class="kicker"></div><div class="line"></div>`;
      el.querySelector('.kicker').textContent = kicker;
      el.querySelector('.line').textContent = line;
      document.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add('visible'));
    },
    { kicker, line },
  );
}

async function hideCaption(page) {
  await page
    .evaluate(() => document.getElementById('demo-caption')?.classList.remove('visible'))
    .catch(() => {});
  await page.waitForTimeout(500);
}

async function showCard(page, html, ms) {
  await injectOverlayStyles(page);
  await page.evaluate((inner) => {
    document.getElementById('demo-card')?.remove();
    const el = document.createElement('div');
    el.id = 'demo-card';
    el.innerHTML = `<div>${inner}</div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
  }, html);
  await page.waitForTimeout(ms);
}

async function hideCard(page) {
  await page.evaluate(() => document.getElementById('demo-card')?.classList.remove('visible'));
  await page.waitForTimeout(700);
  await page.evaluate(() => document.getElementById('demo-card')?.remove());
}

async function smoothScroll(page, to, ms = 1600) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), to);
  await page.waitForTimeout(ms);
}

async function makeImportCsv(categories) {
  const other = categories.other;
  const food = categories.food;
  // account_name resolves each row to the seeded "wallet" account by name —
  // target_account_id is optional in the UI now, so we skip that dropdown.
  const rows = [
    'occurred_at,type,amount,category,description,account_name',
    `${daysAgo(1)},expense,18.20,${food},Card statement — cafe,wallet`,
    `${daysAgo(2)},expense,54.10,${food},Card statement — supermarket,wallet`,
    `${daysAgo(2)},expense,9.99,${other},Card statement — app subscription,wallet`,
    `${daysAgo(4)},expense,33.00,${other},Card statement — pharmacy,wallet`,
    `${daysAgo(5)},expense,72.45,${food},Card statement — restaurant,wallet`,
  ];
  const csvPath = path.join(OUT_DIR, 'demo-import.csv');
  await fs.writeFile(csvPath, rows.join('\n'), 'utf8');
  return csvPath;
}

async function recordTour(browser, storageState, categories) {
  const context = await browser.newContext({
    viewport: SIZE,
    storageState,
    recordVideo: { dir: OUT_DIR, size: SIZE },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = '::-webkit-scrollbar{display:none} html{scrollbar-width:none}';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
  });

  // --- Title card (over the dashboard while it loads) ---
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await showCard(
    page,
    `<h1>Life<em>stack</em></h1>
     <p class="tag">A finance-led personal operations command center</p>
     <ul><li>FastAPI · React 19 · PostgreSQL — spec-driven, CI-gated</li></ul>`,
    3200,
  );
  await hideCard(page);

  // --- 1. Dashboard ---
  await showCaption(page, 'Dashboard', 'One briefing: financial health, tasks, alerts, and your latest weekly summary.');
  await page.waitForTimeout(3500);
  await smoothScroll(page, 600, 1800);
  await page.waitForTimeout(1500);
  await smoothScroll(page, 0, 1200);
  await hideCaption(page);

  // --- 2. Spending ---
  await page.goto(`${WEB}/spending`, { waitUntil: 'networkidle' });
  await showCaption(page, 'Spending', 'Transactions, monthly budgets with guardrail alerts, and recurring rules.');
  await page.waitForTimeout(3200);
  await smoothScroll(page, 500, 1500);
  await page.waitForTimeout(1200);
  await page.getByTestId('spending-tab-budgets').click();
  await page.waitForTimeout(2800);
  await page.getByTestId('spending-tab-recurring').click();
  await page.waitForTimeout(2600);
  await hideCaption(page);

  // --- 3. Imports: live review-before-commit ---
  await page.goto(`${WEB}/imports`, { waitUntil: 'networkidle' });
  await showCaption(page, 'Imports', 'Real data comes in through validated imports — previewed before anything commits.');
  await page.waitForTimeout(2000);
  const csvPath = await makeImportCsv(categories);
  await page.getByRole('button', { name: 'New Import' }).click();
  await page.getByTestId('imports-module-select').selectOption('spending-transactions');
  await page.getByTestId('imports-file-input').setInputFiles(csvPath);
  await page.waitForTimeout(800);
  await page.getByTestId('imports-upload-validate').click();
  await page.getByTestId('imports-commit').waitFor({ state: 'visible', timeout: 20_000 });
  await showCaption(page, 'Imports', 'Every row is validated and shown for review. Nothing lands until you commit.');
  await page.waitForTimeout(4200);
  await hideCaption(page);

  // --- 4. Investing ---
  await page.goto(`${WEB}/investing`, { waitUntil: 'networkidle' });
  await showCaption(page, 'Investing', 'Account-backed holdings, real orders, cash in USD and EUR, FX-aware valuation.');
  await page.waitForTimeout(3200);
  await smoothScroll(page, 650, 1600);
  await page.waitForTimeout(2000);
  await smoothScroll(page, 0, 1000);
  await page.getByTestId('investing-tab-orders').click();
  await page.waitForTimeout(2600);
  await page.getByTestId('investing-tab-cash').click();
  await page.waitForTimeout(2600);
  await hideCaption(page);

  // --- 5. Workspace / settings ---
  await page.goto(`${WEB}/settings`, { waitUntil: 'networkidle' });
  await showCaption(page, 'Workspaces & RBAC', 'Multi-tenant workspaces with roles, audit logging, and a safe demo reset.');
  await page.waitForTimeout(2200);
  await page.getByTestId('settings-tab-danger').click();
  await page.waitForTimeout(1000);
  const resetSection = page.getByTestId('master-demo-reset-section');
  if (await resetSection.count()) {
    await resetSection.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2500);
  } else {
    await smoothScroll(page, 900, 1800);
    await page.waitForTimeout(1500);
  }
  await hideCaption(page);

  // --- 6. Engineering-evidence end card ---
  await showCard(
    page,
    `<h1>Engineered, <em>not assembled</em></h1>
     <p class="tag">github.com/sajankp/lifestack-api</p>
     <ul>
       <li><b>80% / 70%</b> enforced coverage gates (API / web)</li>
       <li><b>18</b> Playwright end-to-end suites against a Dockerized stack</li>
       <li><b>68</b> approved specs — spec-driven development, protected main</li>
     </ul>`,
    4500,
  );

  await context.close(); // flushes the video
  const video = page.video();
  return video ? await video.path() : null;
}

// ---------- main ----------

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    console.log(`[1/3] Registering demo user ${credentials.email} and seeding data...`);
    const setupContext = await browser.newContext({ viewport: SIZE });
    const setupPage = await setupContext.newPage();
    await registerAndLogin(setupPage);
    const { categories } = await seedDemoData(setupContext);
    const storageState = await setupContext.storageState();
    await setupContext.close();

    console.log('[2/3] Recording guided tour...');
    const videoPath = await recordTour(browser, storageState, categories);

    console.log(`[3/3] Done. Raw video: ${videoPath}`);
    if (videoPath) {
      const finalPath = path.join(OUT_DIR, 'lifestack-demo-raw.webm');
      await fs.copyFile(videoPath, finalPath);
      console.log(`Copied to: ${finalPath}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

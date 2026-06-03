#!/usr/bin/env node
import net from 'node:net';

const WEB_BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
const API_BASE_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:8000';
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql+asyncpg://lifestack_e2e:lifestack_e2e@localhost:5433/lifestack_e2e';
const MAX_ATTEMPTS = Number(process.env.E2E_PRECHECK_ATTEMPTS || 30);
const RETRY_DELAY_MS = Number(process.env.E2E_PRECHECK_DELAY_MS || 2000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDatabaseUrl(raw) {
  return raw
    .replace(/^postgresql\+asyncpg:\/\//, 'postgresql://')
    .replace(/^postgres\+asyncpg:\/\//, 'postgres://');
}

function parseDatabaseEndpoint(raw) {
  const normalized = normalizeDatabaseUrl(raw);
  const parsed = new URL(normalized);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
  };
}

async function checkHttp(name, baseUrl, path) {
  const target = new URL(path, baseUrl).toString();
  let lastReason = 'not attempted';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(target, { method: 'GET', signal: controller.signal });
      if (response.ok) {
        console.log(`[OK] ${name} reachable at ${target} (status ${response.status})`);
        return true;
      }
      lastReason = `HTTP ${response.status}`;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  console.error(
    `[FAIL] ${name} unreachable at ${target} after ${MAX_ATTEMPTS} attempts: ${lastReason}`
  );
  return false;
}

async function checkTcp(name, host, port) {
  let lastReason = 'not attempted';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const ok = await new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (connected, message) => {
        socket.destroy();
        if (!connected) {
          lastReason = message;
        }
        resolve(connected);
      };

      socket.setTimeout(3000);
      socket.once('connect', () => done(true, 'connected'));
      socket.once('timeout', () => done(false, 'connection timed out'));
      socket.once('error', (error) => done(false, error.message));
      socket.connect(port, host);
    });

    if (ok) {
        console.log(`[OK] ${name} reachable at ${host}:${port}`);
        return true;
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  console.error(
    `[FAIL] ${name} unreachable at ${host}:${port} after ${MAX_ATTEMPTS} attempts: ${lastReason}`
  );
  return false;
}

async function main() {
  let dbEndpoint;
  try {
    dbEndpoint = parseDatabaseEndpoint(DATABASE_URL);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[FAIL] Could not parse DATABASE URL: ${reason}`);
    process.exit(1);
  }

  const checks = await Promise.all([
    checkHttp('Web UI', WEB_BASE_URL, '/login'),
    checkHttp('API', API_BASE_URL, '/docs'),
    checkTcp('Postgres', dbEndpoint.host, dbEndpoint.port),
  ]);

  if (checks.every(Boolean)) {
    console.log('[OK] Environment precheck passed.');
    return;
  }

  console.error('[FAIL] Environment precheck failed.');
  process.exit(1);
}

await main();

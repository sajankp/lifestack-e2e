#!/usr/bin/env node
import net from 'node:net';

const WEB_BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
const API_BASE_URL = process.env.PLAYWRIGHT_API_URL || 'http://localhost:8000';
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql+asyncpg://lifestack_e2e:lifestack_e2e@localhost:5433/lifestack_e2e';

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(target, { method: 'GET', signal: controller.signal });
    if (response.status >= 500) {
      throw new Error(`HTTP ${response.status}`);
    }
    console.log(`[OK] ${name} reachable at ${target} (status ${response.status})`);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[FAIL] ${name} unreachable at ${target}: ${reason}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkTcp(name, host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok, message) => {
      socket.destroy();
      if (ok) {
        console.log(`[OK] ${name} reachable at ${host}:${port}`);
      } else {
        console.error(`[FAIL] ${name} unreachable at ${host}:${port}: ${message}`);
      }
      resolve(ok);
    };

    socket.setTimeout(8000);
    socket.once('connect', () => done(true, 'connected'));
    socket.once('timeout', () => done(false, 'connection timed out'));
    socket.once('error', (error) => done(false, error.message));
    socket.connect(port, host);
  });
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

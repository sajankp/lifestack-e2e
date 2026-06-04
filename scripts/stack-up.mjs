#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const composeArgs = ['compose', '-f', 'docker-compose.e2e.yml'];
const defaultEnv = {
  ...process.env,
  PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174',
  PLAYWRIGHT_API_URL: process.env.PLAYWRIGHT_API_URL || 'http://localhost:8001',
  E2E_DATABASE_URL:
    process.env.E2E_DATABASE_URL ||
    'postgresql+asyncpg://lifestack_e2e:lifestack_e2e@localhost:5433/lifestack_e2e',
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: defaultEnv,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}
const seedScript = `
import asyncio
from datetime import datetime, UTC
from app.core.database.postgres import async_session_maker
from app.finance.models import FxRate

async def seed():
    async with async_session_maker() as session:
        for base, quote, rate in [("GBP", "USD", 1.25), ("USD", "GBP", 0.8)]:
            session.add(FxRate(
                base_currency_code=base,
                quote_currency_code=quote,
                rate=rate,
                as_of=datetime.now(UTC),
                fetched_at=datetime.now(UTC),
                source="e2e-seed"
            ))
        await session.commit()

asyncio.run(seed())
`.trim();

run('docker', [...composeArgs, 'up', '-d', '--build']);
run('docker', [...composeArgs, 'exec', '-T', 'api-e2e', 'alembic', 'upgrade', 'head']);
run('docker', [...composeArgs, 'exec', '-T', 'api-e2e', 'python', '-c', seedScript]);
run('node', ['./scripts/precheck.mjs']);

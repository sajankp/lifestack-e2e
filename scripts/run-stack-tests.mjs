#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const mode = process.argv[2] === 'smoke' ? 'smoke' : 'full';
const env = {
  ...process.env,
  PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174',
  PLAYWRIGHT_API_URL: process.env.PLAYWRIGHT_API_URL || 'http://localhost:8001',
  E2E_DATABASE_URL:
    process.env.E2E_DATABASE_URL ||
    'postgresql+asyncpg://lifestack_e2e:lifestack_e2e@localhost:5433/lifestack_e2e',
};

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status === null ? 1 : result.status}`
    );
  }
}

let exitCode = 0;

try {
  run('node', ['./scripts/stack-up.mjs']);
  run('npm', ['run', mode === 'smoke' ? 'test:smoke' : 'test:full']);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  exitCode = 1;
} finally {
  if (process.env.KEEP_E2E_STACK !== '1') {
    const downResult = spawnSync('node', ['./scripts/stack-down.mjs'], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env,
    });
    if (downResult.status !== 0 && exitCode === 0) {
      exitCode = downResult.status === null ? 1 : downResult.status;
    }
  }
}

process.exit(exitCode);

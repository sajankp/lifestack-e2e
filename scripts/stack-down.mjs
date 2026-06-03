#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'docker',
  ['compose', '-f', 'docker-compose.e2e.yml', 'down', '-v'],
  {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  }
);

process.exit(result.status === null ? 0 : result.status);

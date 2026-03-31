#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const forwardedArgs = process.argv.slice(2);

const vitestArgs = ['vitest', 'run', ...forwardedArgs];
const vitestResult = spawnSync('npx', vitestArgs, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (vitestResult.status !== 0) {
  process.exit(vitestResult.status ?? 1);
}

const tscResult = spawnSync('npx', ['tsc', '-p', 'tsconfig.test.json', '--noEmit'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(tscResult.status ?? 1);

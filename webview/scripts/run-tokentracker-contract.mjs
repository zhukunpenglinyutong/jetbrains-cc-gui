import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testFile = fileURLToPath(new URL('./tokentracker-contract.test.mjs', import.meta.url));
const result = spawnSync(process.execPath, ['--test', testFile], {
  stdio: 'inherit',
  env: { ...process.env, TOKENTRACKER_CONTRACT: '1' },
});
process.exit(result.status ?? 1);

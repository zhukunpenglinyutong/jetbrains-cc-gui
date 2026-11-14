/**
 * Test helper: an OmpRpcClient wired to the scripted fake in fake-omp-rpc.mjs.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OmpRpcClient } from '../rpc-client.js';

const FAKE_SCRIPT = fileURLToPath(new URL('./fake-omp-rpc.mjs', import.meta.url));

/**
 * @param {object} script see fake-omp-rpc.mjs
 * @returns {{
 *   createClient: (onFrame?: (frame: object) => void) => OmpRpcClient,
 *   received: () => object[],
 *   cleanup: () => void,
 * }} `received` lists the frames the fake read from stdin so far
 */
export function fakeOmp(script) {
  const dir = mkdtempSync(join(tmpdir(), 'ccgui-fake-omp-'));
  const scriptFile = join(dir, 'script.json');
  const logFile = join(dir, 'received.jsonl');
  writeFileSync(scriptFile, JSON.stringify(script));
  writeFileSync(logFile, '');
  return {
    createClient: (onFrame) => new OmpRpcClient({
      bin: process.execPath,
      args: [FAKE_SCRIPT],
      cwd: dir,
      env: { ...process.env, FAKE_OMP_SCRIPT: scriptFile, FAKE_OMP_LOG: logFile },
      onFrame,
    }),
    received: () => readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    // Windows releases a just-exited child's working directory with a short delay.
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

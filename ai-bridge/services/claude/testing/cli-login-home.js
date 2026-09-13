/**
 * Test setup side-effect: point HOME at a throwaway temp dir carrying a
 * CLI-login config, so buildRequestContext() -> setupApiKey() resolves as
 * "cli_login" instead of throwing "API Key not configured" on a clean CI
 * runner that has no ~/.codemoss / ~/.claude credentials.
 *
 * Why this shape:
 * - setupApiKey() reads credentials ONLY from ~/.codemoss + ~/.claude under the
 *   real home dir (it deliberately ignores shell env vars), and getRealHomeDir()
 *   CACHES that path on its first call. So HOME must be redirected BEFORE any
 *   code calls getRealHomeDir(). Importing this module first — above the import
 *   of persistent-query-service.js — guarantees that: ES module imports execute
 *   in source order, and this file has no dependency that touches the home dir.
 * - It is the lightweight, single-process equivalent of the child-process
 *   harness used by runtime-lifecycle.test.js / api-config.test.js for the same
 *   reason. Test-only; no production code is involved.
 *
 * A `claude.current === "__cli_login__"` config makes getClaudeRuntimeState()
 * report access === 'cli_login', which setupApiKey() treats as a valid auth
 * mode and returns without throwing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-test-home-'));
fs.mkdirSync(path.join(tempHome, '.codemoss'), { recursive: true });
fs.writeFileSync(
  path.join(tempHome, '.codemoss', 'config.json'),
  JSON.stringify({ claude: { current: '__cli_login__', providers: {} } }),
  'utf8'
);

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

// Best-effort cleanup when the test process exits.
process.on('exit', () => {
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // ignore — OS will reclaim the temp dir
  }
});

export const testHomeDir = tempHome;

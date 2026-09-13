// Tests for the rewind candidate resolution used by file rewind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// getRealHomeDir() is cached at module load by api-config.js, so the scenario
// runs in a child process with HOME pointed at a temp dir (same pattern as
// the closed-runtime and [1m]-toggle child tests).
test('rewind candidates exclude the CLI interruption marker rows', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-rewind-'));
  try {
    const childPath = fileURLToPath(
      new URL('./message-rewind.child.mjs', import.meta.url)
    );
    const output = execFileSync(process.execPath, [childPath], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.match(output, /SCENARIO_OK/, `child scenario did not pass:\n${output}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

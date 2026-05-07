import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getSessionMessages } from './session-service.js';

test('getSessionMessages returns an empty history when the session file is missing', async () => {
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-session-'));
  const output = [];
  const originalLog = console.log;

  process.env.HOME = tempHome;
  console.log = (message) => output.push(message);
  try {
    await getSessionMessages('missing-session', '/workspace/missing-history');
  } finally {
    console.log = originalLog;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0]), {
    success: true,
    messages: []
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeDshHostCommand } from './supervisor.js';

test('looksLikeDshHostCommand matches the recorded bin path or basename', () => {
  assert.equal(
    looksLikeDshHostCommand(
      '/home/u/.hermes/node/bin/dsh web --host 127.0.0.1',
      '/home/u/.hermes/node/bin/dsh'
    ),
    true
  );
  assert.equal(looksLikeDshHostCommand('node /usr/local/bin/dsh web', '/usr/local/bin/dsh'), true);
  // A shim may show only the basename, not the recorded absolute path.
  assert.equal(looksLikeDshHostCommand('dsh.exe web --port 3080', 'C:\\tools\\dsh.exe'), true);
});

test('looksLikeDshHostCommand accepts dsh-looking tokens when no bin is recorded', () => {
  assert.equal(looksLikeDshHostCommand('dsh web --port 3080', null), true);
  assert.equal(looksLikeDshHostCommand('/usr/local/bin/dsh web', ''), true);
  assert.equal(looksLikeDshHostCommand('node /opt/dsh/dist/dsh.js web', null), true);
  assert.equal(looksLikeDshHostCommand('dsh.cmd web', undefined), true);
});

test('looksLikeDshHostCommand rejects unrelated processes (PID reuse guard)', () => {
  assert.equal(looksLikeDshHostCommand('', null), false);
  assert.equal(looksLikeDshHostCommand('/usr/bin/adsh --serve', null), false);
  assert.equal(looksLikeDshHostCommand('vim /tmp/notes-dsh.txt', null), false);
  assert.equal(looksLikeDshHostCommand('node server.js --name mydsh', null), false);
});

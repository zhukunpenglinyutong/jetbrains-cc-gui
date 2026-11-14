import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { probeCodexCli } from './codex-cli-probe.js';

const planOf = (...paths) => () => ({
  status: 'resolved',
  candidates: paths.map((path) => ({ command: [path], label: path })),
});

test('reports the first candidate that prints a real version', () => {
  const versions = { '/broken/codex': null, '/noise/codex': 'not a version', '/good/codex': 'codex-cli 0.165.0\n' };
  const found = probeCodexCli({
    resolve: planOf('/broken/codex', '/noise/codex', '/good/codex'),
    readVersion: ([path]) => versions[path],
  });

  assert.deepEqual(found, { path: '/good/codex', versionLine: 'codex-cli 0.165.0' });
});

test('stops at the candidate the bridge would start first', () => {
  const asked = [];
  const found = probeCodexCli({
    resolve: planOf('/first/codex', '/second/codex'),
    readVersion: ([path]) => { asked.push(path); return 'codex-cli 1.2.3'; },
  });

  assert.equal(found.path, '/first/codex');
  assert.deepEqual(asked, ['/first/codex']);
});

test('reports the launcher file for a node-launched install, not the node binary', () => {
  const found = probeCodexCli({
    resolve: () => ({ candidates: [{ command: ['/usr/bin/node', '/deps/codex/bin/codex.js'], label: '/deps/codex' }] }),
    readVersion: () => 'codex-cli 1.2.3',
  });

  assert.equal(found.path, '/deps/codex/bin/codex.js');
});

test('returns null when nothing is installed or nothing starts', () => {
  assert.equal(probeCodexCli({ resolve: () => ({ status: 'unresolved', candidates: [] }) }), null);
  assert.equal(probeCodexCli({ resolve: () => ({ status: 'unresolved' }) }), null);
  assert.equal(probeCodexCli({ resolve: planOf('/broken/codex'), readVersion: () => null }), null);
});

// `sh -lc` cannot see these installs: their PATH entry lives in .bashrc, or they
// are not on PATH at all. The bridge finds them, so the settings page must too.
for (const [name, relativeBin] of [
  ['nvm', '.nvm/versions/node/v22.11.0/bin/codex'],
  ['volta', '.volta/bin/codex'],
  ['the older standalone layout', '.codex/packages/standalone/current/codex'],
]) {
  test(`the script finds a Codex installed through ${name}`, { skip: process.platform === 'win32' }, () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-cli-probe-'));
    try {
      const codex = join(home, relativeBin);
      mkdirSync(join(codex, '..'), { recursive: true });
      writeFileSync(codex, '#!/bin/sh\necho codex-cli 0.165.0\n');
      chmodSync(codex, 0o755);

      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./codex-cli-probe.js', import.meta.url))], {
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh' },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${codex}\ncodex-cli 0.165.0\n`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

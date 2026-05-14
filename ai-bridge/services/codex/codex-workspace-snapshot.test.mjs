import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildEditOperationsFromSnapshots, captureWorkspaceSnapshot, diffWorkspaceSnapshots } from './codex-workspace-snapshot.js';

function snapshot(files) {
  return {
    root: '/repo',
    files: new Map(Object.entries(files).map(([filePath, content]) => [filePath, {
      path: filePath,
      existed: true,
      binary: false,
      content,
      length: Buffer.byteLength(content),
      modifiedAtMillis: 0,
    }])),
    totalBytes: 0,
    truncated: false,
  };
}

test('buildEditOperationsFromSnapshots emits rollback-safe write for new text files', () => {
  const operations = buildEditOperationsFromSnapshots('/repo/src/new.js', false, '', 'export const value = 1;\n');

  assert.equal(operations.length, 1);
  assert.equal(operations[0].toolName, 'write');
  assert.equal(operations[0].oldString, '');
  assert.equal(operations[0].newString, 'export const value = 1;\n');
  assert.equal(operations[0].safeToRollback, true);
  assert.equal(operations[0].existedBefore, false);
});

test('diffWorkspaceSnapshots emits focused edit hunks for modified files', () => {
  const before = snapshot({ '/repo/src/app.js': 'one\ntwo\nthree\n' });
  const after = snapshot({ '/repo/src/app.js': 'one\nTWO\nthree\n' });

  const operations = diffWorkspaceSnapshots(before, after);

  assert.equal(operations.length, 1);
  assert.equal(operations[0].toolName, 'edit');
  assert.equal(operations[0].oldString, 'one\ntwo\nthree\n');
  assert.equal(operations[0].newString, 'one\nTWO\nthree\n');
  assert.equal(operations[0].safeToRollback, true);
  assert.equal(operations[0].existedBefore, true);
});

test('captureWorkspaceSnapshot skips dependency folders while keeping project files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-workspace-snapshot-'));
  try {
    await mkdir(join(cwd, 'src'), { recursive: true });
    await mkdir(join(cwd, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(cwd, 'src/app.js'), 'export const app = true;\n', 'utf8');
    await writeFile(join(cwd, 'node_modules/pkg/index.js'), 'ignored\n', 'utf8');

    const captured = await captureWorkspaceSnapshot(cwd);

    assert.ok(captured.files.has(await realpath(join(cwd, 'src/app.js'))));
    assert.equal(captured.files.has(join(cwd, 'node_modules/pkg/index.js')), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('captureWorkspaceSnapshot skips symlinked files and directories outside workspace', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-workspace-snapshot-'));
  const outside = await mkdtemp(join(tmpdir(), 'codex-workspace-outside-'));
  try {
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src/app.js'), 'export const app = true;\n', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'secret\n', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(cwd, 'src/secret-link.txt'));
    await symlink(outside, join(cwd, 'linked-outside-dir'));

    const captured = await captureWorkspaceSnapshot(cwd);

    assert.ok(captured.files.has(await realpath(join(cwd, 'src/app.js'))));
    assert.equal(captured.files.has(join(cwd, 'src/secret-link.txt')), false);
    assert.equal(captured.files.has(join(outside, 'secret.txt')), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

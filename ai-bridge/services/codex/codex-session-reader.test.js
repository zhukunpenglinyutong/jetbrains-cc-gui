import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createSessionReader } from './codex-session-reader.js';

test('growth after an in-place overwrite resets instead of appending a truncated replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-reader-regrown-'));
  const path = join(directory, 'session.jsonl');
  const reader = createSessionReader();
  try {
    await writeFile(path, '{"old":1}\n');
    await reader.read(path);
    const original = await fsPromises.stat(path);
    await writeFile(path, '{"new":"a longer replacement"}\n');
    assert.equal((await fsPromises.stat(path)).ino, original.ino);
    assert.deepEqual((await reader.read(path)).lines, ['{"new":"a longer replacement"}']);
    assert.equal(reader.generation, 2);
    await appendFile(path, '{"next":true}\n');
    assert.deepEqual((await reader.read(path)).lines, ['{"new":"a longer replacement"}', '{"next":true}']);
    assert.equal(reader.generation, 2);
  } finally {
    await reader.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a request during an active scan includes bytes appended after the initial stat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-reader-concurrent-'));
  const path = join(directory, 'session.jsonl');
  await writeFile(path, '{}\n');
  const reader = createSessionReader();
  const originalOpen = fsPromises.open;
  let releaseRead;
  let notifyRead;
  const blockedRead = new Promise((resolve) => { releaseRead = resolve; });
  const readStarted = new Promise((resolve) => { notifyRead = resolve; });
  let activeHandles = 0;
  let peakHandles = 0;
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    activeHandles += 1;
    peakHandles = Math.max(peakHandles, activeHandles);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    handle.read = async (...readArgs) => {
      notifyRead();
      await blockedRead;
      return read(...readArgs);
    };
    handle.close = async () => {
      try { await close(); } finally { activeHandles -= 1; }
    };
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const first = reader.read(path);
    await readStarted;
    await appendFile(path, '[]\n');
    assert.equal(reader.read(path), first);
    releaseRead();
    assert.deepEqual((await first).lines, ['{}', '[]']);
    assert.equal(peakHandles, 1);
    assert.equal(activeHandles, 0);
  } finally {
    releaseRead();
    await reader.dispose();
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test('incremental reader shares concurrent scans and preserves complete JSONL records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-reader-'));
  const path = join(directory, 'session.jsonl');
  const reader = createSessionReader();
  try {
    await writeFile(path, '\n{"text":"中文"}\ninvalid\n{"partial":');
    const first = reader.read(path);
    assert.equal(reader.read(path), first);
    const snapshot = await first;
    assert.deepEqual(snapshot.lines, ['{"text":"中文"}', 'invalid']);
    assert.equal((await reader.read(path)).lines, snapshot.lines);
    await appendFile(path, 'true}\n{}\n');
    assert.deepEqual((await reader.read(path)).lines, ['{"text":"中文"}', 'invalid', '{"partial":true}', '{}']);
    await reader.dispose();
    assert.deepEqual(reader.lines, []);
    assert.equal(reader.offset, 0);
  } finally {
    await reader.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('incremental reader resets on truncation, replacement, same-size rewrite and path switch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-reader-reset-'));
  const path = join(directory, 'session.jsonl');
  const replacement = join(directory, 'replacement.jsonl');
  const reader = createSessionReader();
  try {
    await writeFile(path, 'historical\npartial');
    await reader.read(path);
    await writeFile(path, '{}\n');
    assert.deepEqual((await reader.read(path)).lines, ['{}']);
    await writeFile(replacement, '[]\n');
    await rename(replacement, path);
    assert.deepEqual((await reader.read(path)).lines, ['[]']);
    await writeFile(path, '42\n');
    assert.deepEqual((await reader.read(path)).lines, ['42']);
    await writeFile(replacement, 'null\n');
    assert.deepEqual((await reader.read(replacement)).lines, ['null']);
    assert.equal(reader.generation, 5);
  } finally {
    await reader.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('same-size rewrites invalidate cached lines even when stat metadata is unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-reader-equal-stat-'));
  const path = join(directory, 'session.jsonl');
  const reader = createSessionReader();
  const originalOpen = fsPromises.open;
  try {
    await writeFile(path, '[]\n');
    const originalStat = await fsPromises.stat(path);
    // Freeze metadata to reproduce timestamp collisions deterministically on
    // every platform, without relying on the filesystem's clock resolution.
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      handle.stat = async () => originalStat;
      return handle;
    };
    syncBuiltinESMExports();
    await reader.read(path);
    const cachedLines = reader.lines;
    await reader.read(path);
    assert.equal(reader.lines, cachedLines);
    assert.equal(reader.generation, 1);

    await writeFile(path, '42\n');
    assert.deepEqual((await reader.read(path)).lines, ['42']);
    assert.equal(reader.generation, 2);
    await reader.read(path);
    assert.equal(reader.generation, 2);
  } finally {
    await reader.dispose();
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test('incremental reader decodes Chinese split across its fixed-size read buffers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-reader-chunks-'));
  const path = join(directory, 'session.jsonl');
  const reader = createSessionReader();
  const record = `${' '.repeat(65535)}中文`;
  try {
    await writeFile(path, `${record}\n`);
    assert.deepEqual((await reader.read(path)).lines, [record]);
  } finally {
    await reader.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

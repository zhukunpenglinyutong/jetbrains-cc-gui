import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// node:sqlite requires node >= 22; skip the whole file otherwise.
const sqlite = await import('node:sqlite').catch(() => null);

const SKIP = sqlite ? false : 'node:sqlite unavailable (node < 22)';

function seedDb(home) {
  const dbDir = join(home, 'cli', 'db');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'db.sqlite');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT);
    CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE todo (session_id TEXT, content TEXT);
    CREATE TABLE session_entry (id TEXT, session_id TEXT);
    CREATE TABLE session_input (id TEXT, session_id TEXT);
    CREATE TABLE session_target (session_id TEXT, target_id TEXT);
    CREATE TABLE model_usage (id TEXT, session_id TEXT);
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT);
    CREATE TABLE tool_usage (id TEXT, session_id TEXT);
    CREATE TABLE session_task_link (id TEXT, parent_session_id TEXT, child_session_id TEXT);
  `);
  db.prepare('INSERT INTO session (id, parent_id, title) VALUES (?, NULL, ?)').run('sess_root', 'root');
  db.prepare('INSERT INTO session (id, parent_id, title) VALUES (?, ?, ?)').run('sess_subagent_1', 'sess_root', 'child');
  db.prepare('INSERT INTO session (id, parent_id, title) VALUES (?, NULL, ?)').run('sess_other', 'untouched');
  db.prepare('INSERT INTO session_task_link (id, parent_session_id, child_session_id) VALUES (?, ?, ?)').run('l1', 'sess_root', 'sess_subagent_1');
  for (const sid of ['sess_root', 'sess_subagent_1', 'sess_other']) {
    db.prepare('INSERT INTO message (id, session_id) VALUES (?, ?)').run(`m_${sid}`, sid);
    db.prepare('INSERT INTO part (id, message_id, session_id) VALUES (?, ?, ?)').run(`p_${sid}`, `m_${sid}`, sid);
    db.prepare('INSERT INTO turn_usage (session_id, turn_id) VALUES (?, ?)').run(sid, 't1');
  }
  db.close();
  return dbPath;
}

test('deleteSession removes the session family and dependents in one transaction', { skip: SKIP }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'zcode-test-'));
  seedDb(home);
  process.env.ZCODE_HOME = home;
  try {
    const { deleteSession } = await import('./history-service.js');
    const result = await deleteSession('sess_root');
    assert.deepEqual(result, { success: true });

    const db = new sqlite.DatabaseSync(join(home, 'cli', 'db', 'db.sqlite'), { readOnly: true });
    const remaining = db.prepare('SELECT id FROM session ORDER BY id').all().map((r) => r.id);
    assert.deepEqual(remaining, ['sess_other']);
    // dependent rows of the deleted family are gone; the unrelated session's stay
    const messages = db.prepare('SELECT session_id FROM message').all().map((r) => r.session_id);
    assert.deepEqual(messages, ['sess_other']);
    const links = db.prepare('SELECT id FROM session_task_link').all();
    assert.equal(links.length, 0);
    db.close();
  } finally {
    delete process.env.ZCODE_HOME;
  }
});

test('deleteSession reports unknown session without throwing', { skip: SKIP }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'zcode-test-'));
  seedDb(home);
  process.env.ZCODE_HOME = home;
  try {
    const { deleteSession } = await import('./history-service.js');
    const result = await deleteSession('sess_nonexistent');
    assert.equal(result.success, false);
    assert.match(result.error, /not found/i);
  } finally {
    delete process.env.ZCODE_HOME;
  }
});

test('deleteSession reports missing database', { skip: SKIP }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'zcode-test-'));
  writeFileSync(join(home, 'placeholder'), '');
  process.env.ZCODE_HOME = home;
  try {
    const { deleteSession } = await import('./history-service.js');
    const result = await deleteSession('sess_x');
    assert.equal(result.success, false);
    assert.match(result.error, /database not found/i);
  } finally {
    delete process.env.ZCODE_HOME;
  }
});

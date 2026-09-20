import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseOptionalTurnCursor } from './claude-channel.js';

// ===== parseOptionalTurnCursor =====
//
// Regression cover for the cursor-less pagination bug: Number(null) === 0 and
// Number('') === 0, so coercing before validating turned "no cursor" into "the
// page before turn 0". buildSessionMessagesPagePayload slices [0, 0) for that
// cursor and answers with an empty page + hasMore=false instead of the latest
// page — i.e. the chat looked like it had no history left.

test('parseOptionalTurnCursor keeps a missing cursor as null (caller wants the latest page)', () => {
  assert.equal(parseOptionalTurnCursor(null), null);
  assert.equal(parseOptionalTurnCursor(undefined), null);
  assert.equal(parseOptionalTurnCursor(''), null);
  assert.equal(parseOptionalTurnCursor('   '), null);
});

test('parseOptionalTurnCursor accepts numeric cursors from stdin JSON and argv', () => {
  assert.equal(parseOptionalTurnCursor(0), 0);
  assert.equal(parseOptionalTurnCursor('0'), 0);
  assert.equal(parseOptionalTurnCursor(42), 42);
  assert.equal(parseOptionalTurnCursor('42'), 42);
  assert.equal(parseOptionalTurnCursor(' 42 '), 42);
});

test('parseOptionalTurnCursor rejects unusable cursors so they fall back to the latest page', () => {
  assert.equal(parseOptionalTurnCursor(-1), null);
  assert.equal(parseOptionalTurnCursor('-1'), null);
  assert.equal(parseOptionalTurnCursor(1.5), null);
  assert.equal(parseOptionalTurnCursor('1.5'), null);
  assert.equal(parseOptionalTurnCursor('abc'), null);
  assert.equal(parseOptionalTurnCursor(Number.NaN), null);
  assert.equal(parseOptionalTurnCursor(Infinity), null);
  assert.equal(parseOptionalTurnCursor(true), null);
  assert.equal(parseOptionalTurnCursor({}), null);
});

test('parseOptionalTurnCursor rejects turn indexes beyond safe integers', () => {
  // A cursor this large cannot address a real turn; it must not reach the
  // server as a bogus number.
  assert.equal(parseOptionalTurnCursor(1e21), null);
  assert.equal(parseOptionalTurnCursor('999999999999999999999999'), null);
  assert.equal(parseOptionalTurnCursor(Number.MAX_SAFE_INTEGER + 2), null);
  // The largest addressable cursor is still accepted.
  assert.equal(parseOptionalTurnCursor(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

// ===== channel dispatch: a cursor-less getSessionPage must return the latest page =====

const TURN_COUNT = 4;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHANNEL_URL = new URL('./claude-channel.js', import.meta.url).href;
const PATH_UTILS_URL = new URL('../utils/path-utils.js', import.meta.url).href;

/**
 * Child-process probe: seeds a Claude session JSONL inside a throwaway HOME and
 * drives handleClaudeCommand('getSessionPage', ...) for every cursor shape the
 * bridge has to support.
 *
 * A child process is required because getRealHomeDir() caches the home directory
 * on first use, so HOME/USERPROFILE have to be redirected before any bridge
 * module is imported.
 */
const PAGE_PROBE_SCRIPT = `
import fs from 'node:fs';
import path from 'node:path';

const { handleClaudeCommand } = await import(${JSON.stringify(CHANNEL_URL)});
const { getClaudeProjectSessionFilePath } = await import(${JSON.stringify(PATH_UTILS_URL)});

const sessionId = 'page-cursor-session';
// Keep the fixture under the throwaway HOME: the project key is then derived
// from an isolated directory, so a stray file in the developer's real
// ~/.claude can never satisfy one of the legacy candidate paths.
const cwd = path.join(process.env.HOME || process.env.USERPROFILE, 'paged-project');
fs.mkdirSync(cwd, { recursive: true });
const sessionFile = getClaudeProjectSessionFilePath(sessionId, cwd);
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });

const lines = [];
for (let i = 0; i < ${TURN_COUNT}; i++) {
  lines.push(JSON.stringify({ type: 'user', uuid: 'u' + i, message: { role: 'user', content: 'q' + i } }));
  lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'a' + i } }));
}
fs.writeFileSync(sessionFile, lines.join('\\n') + '\\n', 'utf8');

// handleClaudeCommand answers on stdout, so capture it per scenario.
const captured = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
  captured.push(String(chunk));
  if (typeof encoding === 'function') encoding();
  else if (typeof callback === 'function') callback();
  return true;
};

const run = async (args, stdinData) => {
  captured.length = 0;
  await handleClaudeCommand('getSessionPage', args, stdinData);
  return JSON.parse(captured.join(''));
};

const result = {
  // Java passes "" as the cursor argument when beforeTurn is null.
  emptyStringCursor: await run([sessionId, cwd, '', '2'], null),
  // A direct CLI call omits the cursor argument entirely.
  missingCursorArgs: await run([sessionId, cwd], null),
  // stdin JSON stays supported.
  stdinJsonCursor: await run([sessionId, cwd], { sessionId, cwd, beforeTurn: 2, limit: 2 }),
  // An explicit turn-0 cursor still means "nothing before the first turn".
  explicitZeroCursor: await run([sessionId, cwd, '0', '2'], null),
};

process.stdout.write = realWrite;
realWrite(JSON.stringify(result) + '\\n');
`;

test('getSessionPage without a cursor returns the latest page instead of an empty page', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-page-cursor-'));
  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', PAGE_PROBE_SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
      encoding: 'utf8',
      timeout: 120000,
    });
    const pages = JSON.parse(stdout.trim().split('\n').pop());

    for (const [label, page] of [
      ['empty-string cursor', pages.emptyStringCursor],
      ['missing cursor args', pages.missingCursorArgs],
    ]) {
      assert.equal(page.success, true, `${label}: the page request should succeed`);
      assert.equal(page.totalTurns, TURN_COUNT, `${label}: the fixture should expose every turn`);
      assert.equal(page.toTurn, TURN_COUNT, `${label}: a cursor-less request must page from the end`);
      assert.notEqual(page.messages.length, 0, `${label}: must not answer with an empty page`);
    }

    // Limit 2 out of 4 turns -> the last two turns, with older turns left over.
    assert.equal(pages.emptyStringCursor.fromTurn, TURN_COUNT - 2);
    assert.equal(pages.emptyStringCursor.messages.length, 4);
    assert.equal(pages.emptyStringCursor.hasMore, true);

    // Default limit (30) covers the whole fixture.
    assert.equal(pages.missingCursorArgs.fromTurn, 0);
    assert.equal(pages.missingCursorArgs.messages.length, TURN_COUNT * 2);
    assert.equal(pages.missingCursorArgs.hasMore, false);

    // stdin JSON keeps selecting the requested page.
    assert.equal(pages.stdinJsonCursor.toTurn, 2);
    assert.equal(pages.stdinJsonCursor.messages.length, 4);
    assert.equal(pages.stdinJsonCursor.hasMore, false);

    // An explicit 0 cursor is still a real cursor, not a synonym for "latest".
    assert.equal(pages.explicitZeroCursor.toTurn, 0);
    assert.equal(pages.explicitZeroCursor.messages.length, 0);
    assert.equal(pages.explicitZeroCursor.hasMore, false);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseOptionalTurnCursor } from './claude-channel.js';
import { buildSessionMessagesPagePayload } from '../services/claude/session-service.js';

test('parseOptionalTurnCursor treats absent cursors as the latest page', () => {
  for (const raw of [undefined, null, '', '   ', '\t\n']) {
    assert.equal(parseOptionalTurnCursor(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

test('parseOptionalTurnCursor keeps an explicit turn zero', () => {
  // Zero is a valid cursor ("the page before the first turn"), and it is exactly
  // the value Number(null) and Number('') would produce, so it must be preserved
  // only when the caller supplied it explicitly.
  for (const raw of [0, '0', ' 0 ', '00']) {
    assert.equal(parseOptionalTurnCursor(raw), 0, `expected 0 for ${JSON.stringify(raw)}`);
  }
});

test('parseOptionalTurnCursor accepts non-negative integer cursors', () => {
  assert.equal(parseOptionalTurnCursor(1), 1);
  assert.equal(parseOptionalTurnCursor(42), 42);
  assert.equal(parseOptionalTurnCursor(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(parseOptionalTurnCursor('42'), 42);
  assert.equal(parseOptionalTurnCursor(' 42 '), 42);
  assert.equal(parseOptionalTurnCursor('0012'), 12);
});

test('parseOptionalTurnCursor rejects negative, fractional and non-numeric cursors', () => {
  for (const raw of [-1, '-1', 1.5, '1.5', NaN, 'abc', 'NaN', 'twelve']) {
    assert.equal(parseOptionalTurnCursor(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

test('parseOptionalTurnCursor rejects values that are neither strings nor numbers', () => {
  // A JSON request can carry any type for beforeTurn; booleans and containers
  // must not be coerced through Number.
  for (const raw of [true, false, {}, [], [42], { turn: 4 }]) {
    assert.equal(parseOptionalTurnCursor(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

test('parseOptionalTurnCursor leaves the upper bound to the payload builder', () => {
  // Only buildSessionMessagesPagePayload knows the history length, so an
  // oversized integer passes through and is answered there with cursorReset.
  assert.equal(parseOptionalTurnCursor(1e21), 1e21);
  assert.equal(parseOptionalTurnCursor('1e21'), 1e21);
  assert.equal(parseOptionalTurnCursor(Number.MAX_SAFE_INTEGER + 1), Number.MAX_SAFE_INTEGER + 1);
});

test('parseOptionalTurnCursor rejects non-finite cursors', () => {
  for (const raw of [Infinity, -Infinity, 'Infinity', '-Infinity']) {
    assert.equal(parseOptionalTurnCursor(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

/**
 * Helper: write a JSONL session with `turnCount` user/assistant pairs.
 * Each user message gets a uuid so it counts as a turn start.
 */
function writeTurnFixture(turnCount) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-channel-'));
  const file = path.join(tempDir, 'session.jsonl');
  const lines = [];
  for (let i = 0; i < turnCount; i++) {
    lines.push(JSON.stringify({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `q${i}` } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `a${i}` } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { tempDir, file };
}

test('a cursor beyond the history is answered with the latest page and cursorReset', () => {
  const { tempDir, file } = writeTurnFixture(5);
  try {
    // The Java client replaces its transcript only when cursorReset is set and
    // prepends the page otherwise, so a latest page returned without the flag
    // would duplicate every visible message. The size of the cursor does not
    // change that: 6 and 1e21 are equally beyond a five-turn history.
    for (const raw of ['6', '1000', String(Number.MAX_SAFE_INTEGER), '9007199254740993', '1e21']) {
      const page = buildSessionMessagesPagePayload(file, parseOptionalTurnCursor(raw), 30);
      assert.equal(page.cursorReset, true, `expected cursorReset for ${raw}`);
      assert.equal(page.fromTurn, 0);
      assert.equal(page.toTurn, 5);
      assert.equal(page.messages[0].message.content, 'q0');
      assert.equal(page.messages[page.messages.length - 1].message.content, 'a4');
    }

    // A cursor equal to the history length is still in range.
    const page = buildSessionMessagesPagePayload(file, parseOptionalTurnCursor('5'), 30);
    assert.equal(page.cursorReset, false);
    assert.equal(page.toTurn, 5);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

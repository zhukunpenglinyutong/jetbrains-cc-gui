import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSessionTitleRequest,
  buildRegenerationInput,
  collectSessionUserPrompts,
  regenerateSessionTitle,
} from './session-title-service.js';

// Silence daemon-event lines the service writes via the out-of-band stdout
// writer so they don't interleave with the test runner's TAP output.
process.stdout._originalStdoutWrite = () => {};

// ---------- buildSessionTitleRequest (#1693 follow-up) ----------

test('buildSessionTitleRequest disables thinking so reasoning models still emit text', () => {
  // The Haiku alias can be user-mapped to a reasoning model (e.g. DeepSeek via
  // relay). With thinking left on, the budget is consumed by `thinking` blocks
  // and no title text is ever returned. The ceiling also has to leave room for
  // relays that ignore thinking:{type:'disabled'}.
  const request = buildSessionTitleRequest('deepseek-reasoner', 'fix the login bug');
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.equal(request.model, 'deepseek-reasoner');
  assert.equal(request.max_tokens, 2048);
  assert.deepEqual(request.messages, [{ role: 'user', content: 'fix the login bug' }]);
});

test('buildSessionTitleRequest always attaches the title system prompt', () => {
  const request = buildSessionTitleRequest('claude-haiku-4-5-20251001', 'hello');
  assert.equal(typeof request.system, 'string');
  assert.match(request.system, /concise title/);
});

// ---------- collectSessionUserPrompts / buildRegenerationInput ----------

const SESSION_ID = '48998a72-59ed-455a-9908-28a2b9225b44';

function userRow(text, { meta = false } = {}) {
  return {
    type: 'user',
    uuid: 'u-' + text.length,
    isMeta: meta || undefined,
    message: { role: 'user', content: text },
  };
}

test('collectSessionUserPrompts keeps real prompts and drops CLI plumbing rows', () => {
  const rows = [
    userRow('<command-name>/clear</command-name>'),
    userRow('修复登录按钮', { meta: true }),
    { type: 'user', uuid: 'u-int', message: { role: 'user', content: '[Request interrupted by user]' } },
    { type: 'user', uuid: 'u-tool', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'done' } },
    userRow('修复登录按钮'),
    userRow('补充移动端样式'),
  ];
  assert.deepEqual(collectSessionUserPrompts(rows), ['修复登录按钮', '补充移动端样式']);
});

test('buildRegenerationInput anchors on the first prompt and keeps recent ones', () => {
  const prompts = ['first', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  assert.equal(buildRegenerationInput(prompts), 'first\n\np4\n\np5\n\np6\n\np7');
  assert.equal(buildRegenerationInput(['only']), 'only');
  assert.equal(buildRegenerationInput([]), null);
});

// ---------- regenerateSessionTitle ----------

function regenerationHarness({
  rows = [userRow('修复登录按钮'), userRow('补充移动端样式')],
  enabled = true,
  generatedTitle = '修复登录按钮移动端问题',
  persistSucceeds = true,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'title-regen-'));
  const sessionFile = join(dir, SESSION_ID + '.jsonl');
  writeFileSync(sessionFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

  const calls = { generated: [], saved: [] };
  const result = regenerateSessionTitle(SESSION_ID, null, {
    isEnabled: async () => enabled,
    resolveSessionFile: () => sessionFile,
    generateTitle: async (input) => {
      calls.generated.push(input);
      return typeof generatedTitle === 'function' ? generatedTitle(input) : generatedTitle;
    },
    saveTitle: async (title) => {
      calls.saved.push(title);
      return persistSucceeds;
    },
  });
  return {
    result, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('regenerateSessionTitle derives the input from conversation prompts and saves the new title', async () => {
  const h = regenerationHarness();
  const result = await h.result;
  h.cleanup();
  assert.deepEqual(result, { success: true, title: '修复登录按钮移动端问题' });
  assert.deepEqual(h.calls.generated, ['修复登录按钮\n\n补充移动端样式']);
  assert.deepEqual(h.calls.saved, ['修复登录按钮移动端问题']);
});

test('regenerateSessionTitle fails with a stable code and never touches the title on failure', async () => {
  const cases = [
    { options: { rows: [{ type: 'assistant', uuid: 'a', message: { role: 'assistant', content: 'hi' } }] },
      expected: { success: false, code: 'empty_session' } },
    { options: { enabled: false }, expected: { success: false, code: 'disabled' } },
    { options: { generatedTitle: null }, expected: { success: false, code: 'generation_failed' } },
    { options: { generatedTitle: () => { throw new Error('network down'); } },
      expected: { success: false, code: 'generation_failed' } },
    // The persist attempt happens and fails at the FS layer; the original
    // ai-title row stays intact because nothing was appended.
    { options: { persistSucceeds: false },
      expected: { success: false, code: 'persist_failed' }, saved: ['修复登录按钮移动端问题'] },
  ];
  for (const { options, expected, saved = [] } of cases) {
    const h = regenerationHarness(options);
    const result = await h.result;
    h.cleanup();
    assert.deepEqual(result, expected);
    assert.deepEqual(h.calls.saved, saved);
  }
});

test('regenerateSessionTitle rejects a missing session file and invalid session ids', async () => {
  const missing = await regenerateSessionTitle(SESSION_ID, null, { resolveSessionFile: () => 'Z:/no/such/file.jsonl' });
  assert.deepEqual(missing, { success: false, code: 'session_not_found' });

  const invalid = await regenerateSessionTitle('../escape-attempt', null);
  assert.deepEqual(invalid, { success: false, code: 'invalid_session' });
});

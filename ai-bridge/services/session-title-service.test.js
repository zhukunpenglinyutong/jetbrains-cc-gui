import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSessionTitleRequest,
  buildRegenerationInput,
  collectSessionUserPrompts,
  regenerateSessionTitle,
  __testing,
} from './session-title-service.js';
import { buildSessionClaudeConfig } from '../config/session-supplier.js';

// Silence daemon-event lines the service writes via the out-of-band stdout
// writer so they don't interleave with the test runner's TAP output.
process.stdout._originalStdoutWrite = () => {};

test('bound Bedrock titles use their captured AWS credentials, endpoint and model', async () => {
  const before = { ...process.env };
  let receivedOptions;
  let request;
  class BedrockFixture {
    constructor(options) { receivedOptions = options; }
    messages = { create: async input => {
      request = input;
      return { content: [{ type: 'text', text: '{"title":"Supplier-local title"}' }] };
    } };
  }
  const supplier = { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_ACCESS_KEY_ID: 'fixture-access',
    AWS_SECRET_ACCESS_KEY: 'fixture-secret', AWS_SESSION_TOKEN: 'fixture-session', AWS_REGION: 'fixture-region',
    ANTHROPIC_BEDROCK_BASE_URL: 'https://fixture.example.invalid', ANTHROPIC_AUTH_TOKEN: 'irrelevant-api-token' },
  settings: { env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-cloud-haiku' } } };
  const title = await __testing.callHaikuApi('fix a bug', 'fixture-title', supplier, {
    bedrockSdk: async () => ({ AnthropicBedrock: BedrockFixture }),
    anthropicSdk: async () => { throw new Error('Bound cloud title cannot use the direct Anthropic endpoint'); },
  });
  assert.equal(title, 'Supplier-local title');
  assert.equal(request.model, 'fixture-cloud-haiku');
  assert.equal(receivedOptions.apiKey, null);
  assert.equal(receivedOptions.awsAccessKey, 'fixture-access');
  assert.equal(receivedOptions.awsSecretKey, 'fixture-secret');
  assert.equal(receivedOptions.awsSessionToken, 'fixture-session');
  assert.equal(receivedOptions.awsRegion, 'fixture-region');
  assert.equal(receivedOptions.baseURL, 'https://fixture.example.invalid');
  assert.equal(receivedOptions.defaultHeaders['x-opencode-session'], 'fixture-title');
  assert.deepEqual({ ...process.env }, before);
});

test('cloud titles never fall back to unrelated direct API credentials or a global AWS profile', async () => {
  const noSdk = async () => { throw new Error('Unsupported direct title credentials must not start a client'); };
  for (const env of [
    { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'fixture-profile' },
    { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_AUTH_TOKEN: 'irrelevant-api-token' },
    { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_API_KEY: 'irrelevant-api-key' },
  ]) {
    assert.equal(await __testing.callHaikuApi('hello', 'fixture-title', { env, settings: {} },
      { bedrockSdk: noSdk, anthropicSdk: noSdk }), null);
  }
});

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

// ---------- thinking setting per model (#1949) ----------

test('buildSessionTitleRequest uses between_tools for Claude Sonnet 5.5', () => {
  const request = buildSessionTitleRequest('claude-sonnet-5-5', 'fix the login bug');
  assert.deepEqual(request.thinking, { type: 'between_tools' });
  assert.equal(request.max_tokens, 2048);
});

test('buildSessionTitleRequest omits thinking and lowers effort for Claude Opus 5.5', () => {
  const request = buildSessionTitleRequest('claude-opus-5-5', 'fix the login bug');
  assert.equal('thinking' in request, false);
  assert.deepEqual(request.output_config, { effort: 'low' });
  assert.ok(request.max_tokens >= 4096);
});

// ---------- collectSessionUserPrompts / buildRegenerationInput ----------

const SESSION_ID = '48998a72-59ed-455a-9908-28a2b9225b44';

function userRow(text, { meta = false, rowExtras = {} } = {}) {
  return {
    type: 'user',
    uuid: 'u-' + text.length,
    isMeta: meta || undefined,
    message: { role: 'user', content: text },
    ...rowExtras,
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

// After /compact (or auto-compaction) the CLI appends its summary as a
// type:"user" row — with isCompactSummary/isVisibleInTranscriptOnly set but no
// isMeta, and tens of thousands of CLI-generated characters. It must not be
// collected as user input, or it drowns out what the user actually wrote.
test('collectSessionUserPrompts skips compaction summaries, transcript-only and sidechain rows', () => {
  const compactSummary = 'This session is being continued from a previous conversation. '
    + 'x'.repeat(19000);
  const rows = [
    userRow('修复登录按钮'),
    userRow(compactSummary, { rowExtras: { isCompactSummary: true, isVisibleInTranscriptOnly: true } }),
    userRow('sidechain prompt', { rowExtras: { isSidechain: true } }),
    userRow('补充移动端样式'),
  ];
  assert.deepEqual(collectSessionUserPrompts(rows), ['修复登录按钮', '补充移动端样式']);
});

// Every turn sent with a file open carries the plugin's IDE context block:
// leading since #2092, trailing before it. A leading '<system-reminder>' made
// the whole prompt look like CLI plumbing, so regeneration hit empty_session.
const IDE_CONTEXT = '<system-reminder>\nThe following IDE context applies to the user message below.\n'
  + 'Active file: /repo/src/Login.java\n</system-reminder>';
const LEGACY_IDE_CONTEXT = '<system-reminder>\nThe following IDE context applies only to this user message.\n'
  + 'Selected code: button.onClick(null);\n</system-reminder>';

test('collectSessionUserPrompts drops the plugin IDE context block in both layouts', () => {
  const blocksRow = (...texts) => ({
    type: 'user', message: { role: 'user', content: texts.map((text) => ({ type: 'text', text })) },
  });
  const rows = [
    blocksRow(IDE_CONTEXT, '[Attachment: notes.txt]', 'Fix the login button crash'),
    blocksRow('Add a unit test', LEGACY_IDE_CONTEXT),
    // A lone block is the user's own text, even when it quotes the wrapper.
    blocksRow(IDE_CONTEXT),
  ];
  assert.deepEqual(collectSessionUserPrompts(rows),
    ['[Attachment: notes.txt]\nFix the login button crash', 'Add a unit test']);
});

// Same drift guard as Java ClaudeIdeContextPresentationTest: the bridge must
// still write the wrapper this filter removes.
test('the bridge still writes the IDE context wrapper the title filter removes', () => {
  const bridge = readFileSync(new URL('./claude/persistent-query-service.js', import.meta.url), 'utf8');
  assert.ok(bridge.includes('text: `' + IDE_CONTEXT.split('Active file')[0].replace(/\n/g, '\\n')));
});

test('buildRegenerationInput anchors on the first prompt and keeps recent ones', () => {
  const prompts = ['first', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  assert.equal(buildRegenerationInput(prompts), 'first\n\np4\n\np5\n\np6\n\np7');
  assert.equal(buildRegenerationInput(['only']), 'only');
  assert.equal(buildRegenerationInput([]), null);
});

// Each prompt gets its own budget instead of tail-truncating the joined text,
// so one long recent prompt (a pasted stack trace is enough) can no longer
// evict the anchoring first prompt from the model input.
test('buildRegenerationInput truncates each prompt to its own budget so the first prompt survives', () => {
  const prompts = ['FIRST-PROMPT: build OAuth login flow', 'p2', 'p3', 'p4', 'p5', 'x'.repeat(1200)];
  const input = buildRegenerationInput(prompts);
  assert.ok(input.includes('FIRST-PROMPT'));
  const [first, ...recent] = input.split('\n\n');
  assert.equal(first, 'FIRST-PROMPT: build OAuth login flow');
  assert.deepEqual(recent, ['p3', 'p4', 'p5', 'x'.repeat(150)]);
  // Budgets sum to MAX_CONVERSATION_TEXT-level ceilings: first 400, each recent 150.
  assert.equal(buildRegenerationInput(['y'.repeat(600), 'z'.repeat(200)]), 'y'.repeat(400) + '\n\n' + 'z'.repeat(150));
});

// Truncation keeps the HEAD of an over-budget prompt: prompts open with the
// request ("Please explain this stack trace…") and end with the paste, so
// tail-keeping fed the model only the end of the paste and dropped the ask.
test('buildRegenerationInput keeps the head of an over-budget prompt', () => {
  const instruction = 'Please explain why this Java stack trace happens and fix it:\n';
  const stackTrace = Array.from({ length: 40 }, (_, i) => '\tat com.example.Foo.bar(Foo.java:' + i + ')').join('\n');
  const input = buildRegenerationInput([instruction + stackTrace]);
  assert.ok(input.startsWith('Please explain why this Java stack trace happens'));
  assert.ok(!input.includes('Foo.java:39'));
});

// ---------- regenerateSessionTitle ----------

function regenerationHarness({
  rows = [userRow('修复登录按钮'), userRow('补充移动端样式')],
  enabled = true,
  generatedTitle = '修复登录按钮移动端问题',
  persistSucceeds = true,
  supplierId = null,
  resolveSupplier = () => null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'title-regen-'));
  const sessionFile = join(dir, SESSION_ID + '.jsonl');
  writeFileSync(sessionFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

  const calls = { generated: [], saved: [], supplierIds: [], suppliers: [] };
  const result = regenerateSessionTitle(SESSION_ID, null, supplierId, {
    isEnabled: async () => enabled,
    resolveSessionFile: () => sessionFile,
    // Default off so the harness never consults the developer's real
    // session-titles.json (the production default would).
    hasCustomTitle: () => false,
    // Default to the global profile so the harness never reads the developer's
    // real supplier configuration.
    resolveSupplier: (id) => {
      calls.supplierIds.push(id);
      return resolveSupplier(id);
    },
    generateTitle: async (input, supplier) => {
      calls.generated.push(input);
      calls.suppliers.push(supplier);
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

// The collector streams the JSONL file (no whole-file read: long sessions grow
// past V8's maximum string length) and keeps only the first prompt plus a
// rolling window of the recent ones, skipping compaction summary rows.
test('regenerateSessionTitle collects first prompt plus recent window, skipping compaction summaries', async () => {
  const compactSummary = 'This session is being continued from a previous conversation. '
    + 'x'.repeat(19000);
  const rows = [
    userRow('FIRST-PROMPT: build OAuth login flow'),
    userRow(compactSummary, { rowExtras: { isCompactSummary: true, isVisibleInTranscriptOnly: true } }),
    userRow('p2'),
    userRow('p3'),
    userRow('p4'),
    userRow('p5'),
    userRow('p6'),
  ];
  const h = regenerationHarness({ rows });
  const result = await h.result;
  h.cleanup();
  assert.deepEqual(result, { success: true, title: '修复登录按钮移动端问题' });
  assert.deepEqual(h.calls.generated, ['FIRST-PROMPT: build OAuth login flow\n\np3\n\np4\n\np5\n\np6']);
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
  const missing = await regenerateSessionTitle(SESSION_ID, null, null, {
    resolveSessionFile: () => 'Z:/no/such/file.jsonl',
    hasCustomTitle: () => false,
  });
  assert.deepEqual(missing, { success: false, code: 'session_not_found' });

  const invalid = await regenerateSessionTitle('../escape-attempt', null);
  assert.deepEqual(invalid, { success: false, code: 'invalid_session' });
});

// The backend is the source of truth for manual titles (the webview's history
// snapshot can be stale or miss the session entirely): a session renamed in
// session-titles.json must not regenerate — a manual title wins over any AI
// title, so the call would only produce a false success.
test('regenerateSessionTitle refuses a session with a manual title before calling Haiku', async () => {
  let generated = 0;
  const result = await regenerateSessionTitle(SESSION_ID, null, null, {
    hasCustomTitle: () => true,
    generateTitle: async () => {
      generated += 1;
      return 'should never be reached';
    },
  });
  assert.deepEqual(result, { success: false, code: 'custom_title' });
  assert.equal(generated, 0);
});

// A conversation bound to a supplier (per-conversation suppliers) must title
// through that supplier, as the first-turn title does: the global profile can
// be another account or CLI login.
const SUPPLIER_CONFIG = { claude: { current: 'global-a', providers: {
  'global-a': { settingsConfig: { env: {
    ANTHROPIC_AUTH_TOKEN: 'token-a', ANTHROPIC_BASE_URL: 'https://global-a.example.invalid' } } },
  'conversation-b': { settingsConfig: { env: {
    ANTHROPIC_AUTH_TOKEN: 'token-b', ANTHROPIC_BASE_URL: 'https://conversation-b.example.invalid',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-on-b' } } },
} } };
const resolveFixtureSupplier = (id) => buildSessionClaudeConfig(id, { config: SUPPLIER_CONFIG, baseEnv: {} });

test('regenerateSessionTitle titles through the supplier the conversation is bound to', async () => {
  const bound = regenerationHarness({ supplierId: 'conversation-b', resolveSupplier: resolveFixtureSupplier });
  const result = await bound.result;
  bound.cleanup();
  assert.deepEqual(result, { success: true, title: '修复登录按钮移动端问题' });
  assert.deepEqual(bound.calls.supplierIds, ['conversation-b']);
  const [supplier] = bound.calls.suppliers;
  assert.equal(supplier.env.ANTHROPIC_BASE_URL, 'https://conversation-b.example.invalid');
  assert.equal(supplier.env.ANTHROPIC_AUTH_TOKEN, 'token-b');
  assert.equal(supplier.settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'haiku-on-b');

  // Without a binding the global profile stays in charge, as before.
  const unbound = regenerationHarness({ resolveSupplier: resolveFixtureSupplier });
  await unbound.result;
  unbound.cleanup();
  assert.deepEqual(unbound.calls.suppliers, [null]);
});

test('regenerateSessionTitle fails with supplier_unavailable before calling the model', async () => {
  const h = regenerationHarness({ supplierId: 'deleted-supplier', resolveSupplier: resolveFixtureSupplier });
  const result = await h.result;
  h.cleanup();
  assert.deepEqual(result, {
    success: false,
    code: 'supplier_unavailable',
    error: 'The conversation supplier is unavailable or invalid. Select a configured supplier.',
  });
  assert.deepEqual(h.calls.generated, []);
  assert.deepEqual(h.calls.saved, []);
});

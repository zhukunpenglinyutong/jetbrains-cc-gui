/** End-to-end fixture: runs only under the temporary home supplied by its parent test. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getCodemossDir } from '../../utils/path-utils.js';
import { __testing as claude } from '../../services/claude/persistent-query-service.js';

const events = [];
process.stdout._originalStdoutWrite = chunk => {
  for (const line of String(chunk).split('\n').filter(Boolean)) {
    try { events.push(JSON.parse(line)); } catch { /* ignore non-event markers */ }
  }
  return true;
};
const codex = await import('../../services/codex/persistent-codex-service.js');
const configPath = join(getCodemossDir(), 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const sharedHistory = join(process.env.USERPROFILE || process.env.HOME, '.codex');
codex.setCodexPristineBaseEnv({ ...process.env, CODEX_HOME: sharedHistory });
const options = { titleDependencies: { enabled: async () => false } };
const request = (channelId, supplierId) => ({ channelId, supplierId, cwd: process.cwd(), sessionEpoch: `epoch-${channelId}`,
  codexHome: sharedHistory, message: 'fixture routing', model: 'fixture-model',
  codexCommandPrefix: [process.execPath, resolve('ai-bridge/services/codex/testing/codex-stdio-peer.js'), '--scenario', 'session-supplier'] });
const diagnostics = channel => events.filter(event => event.channelId === channel && event.kind === 'itemCompleted'
  && event.payload.item.type === 'agentMessage').map(event => JSON.parse(event.payload.item.text));
const hash = value => createHash('sha256').update(value).digest('hex');

try {
  const beforeEnv = { ...process.env };
  const [claudeA, claudeB] = await Promise.all(['a', 'b'].map(supplierId => claude.buildRequestContext({
    supplierId, message: 'fixture', model: 'claude-sonnet-5', cwd: process.cwd(),
  })));
  assert.equal(claudeA.options.env.ANTHROPIC_AUTH_TOKEN, 'fixture-a');
  assert.equal(claudeB.options.env.ANTHROPIC_AUTH_TOKEN, 'fixture-b');
  assert.equal(claudeA.options.model, 'a-model');
  assert.equal(claudeB.options.model, 'b-model');
  assert.equal(claudeB.options.settings.env.ANTHROPIC_AUTH_TOKEN, 'fixture-b');
  assert.equal(claudeB.options.settings.env.ANTHROPIC_BASE_URL, 'https://b.example.invalid');
  assert.equal(claudeB.options.settings.env.CLAUDE_CODE_USE_BEDROCK, '');
  assert.deepEqual({ ...process.env }, beforeEnv);
  assert.notEqual(claudeA.runtimeSignature, claudeB.runtimeSignature);
  assert.equal(claudeA.supplier.env.ANTHROPIC_AUTH_TOKEN, 'fixture-a', 'title uses the captured supplier');

  const a = request('fixture-a', 'a');
  const b = request('fixture-b', 'b');
  const result = await Promise.all([codex.codexSendPersistent(a, options), codex.codexSendPersistent(b, options)]);
  assert.ok(result.every(item => item.outcome === 'completed'));
  assert.equal(diagnostics('fixture-a').at(-1).baseUrl, 'https://a.example.invalid/v1');
  assert.equal(diagnostics('fixture-a').at(-1).credentialHash, hash('fixture-a'));
  assert.equal(diagnostics('fixture-b').at(-1).baseUrl, 'https://b.example.invalid/v1');
  assert.equal(diagnostics('fixture-b').at(-1).credentialHash, hash('fixture-b'));
  assert.equal(diagnostics('fixture-a').at(-1).model, 'a-codex-model');
  assert.equal(diagnostics('fixture-b').at(-1).model, 'b-codex-model');
  assert.equal(diagnostics('fixture-a').at(-1).codexHome, sharedHistory);
  assert.equal(diagnostics('fixture-b').at(-1).codexHome, sharedHistory);
  const nativeHomeBefore = readFileSync(join(sharedHistory, 'config.toml'), 'utf8');
  const authBefore = readFileSync(join(sharedHistory, 'auth.json'), 'utf8');

  await codex.codexUpdateSettingsPersistent({ ...b, settings: { model: 'fixture-model', collaborationMode: 'plan' } });
  await codex.codexSendPersistent(b, options);
  assert.equal(diagnostics('fixture-b').at(-1).collaborationMode.settings.model, 'b-codex-model');
  const plan = events.filter(event => event.channelId === b.channelId && event.kind === 'planUpdated'
    && event.payload.authoritative).at(-1);
  assert.ok(plan, 'the completed native plan is available for execution');
  const execution = await codex.codexExecutePlanPersistent({ ...b, threadId: plan.threadId,
    planItemId: plan.payload.item.id, planText: plan.payload.item.text });
  assert.equal(execution.outcome, 'completed');
  assert.equal(diagnostics('fixture-b').at(-1).collaborationMode.settings.model, 'b-codex-model');
  assert.equal(diagnostics('fixture-b').at(-1).collaborationMode.mode, 'default');
  await codex.codexUpdateSettingsPersistent({ ...b, settings: { collaborationMode: {
    mode: 'plan', settings: { model: 'fixture-model', reasoning_effort: 'medium', developer_instructions: null },
  } } });
  await codex.codexSendPersistent(b, options);
  assert.equal(diagnostics('fixture-b').at(-1).collaborationMode.settings.model, 'b-codex-model');

  config.codex.current = 'b';
  writeFileSync(configPath, JSON.stringify(config));
  await codex.codexSendPersistent(a, options);
  assert.equal(diagnostics('fixture-a').at(-1).credentialHash, hash('fixture-a'));
  await codex.codexSendPersistent({ ...a, supplierId: 'b' }, options);
  assert.equal(diagnostics('fixture-a').at(-1).credentialHash, hash('fixture-b'));
  assert.equal(diagnostics('fixture-a').at(-1).baseUrl, 'https://b.example.invalid/v1');
  assert.equal(readFileSync(join(sharedHistory, 'config.toml'), 'utf8'), nativeHomeBefore);
  assert.equal(readFileSync(join(sharedHistory, 'auth.json'), 'utf8'), authBefore);
  delete config.codex.providers.a;
  writeFileSync(configPath, JSON.stringify(config));
  await assert.rejects(codex.codexSendPersistent(a, options), { code: 'SESSION_SUPPLIER_UNAVAILABLE' });
  process.stdout.write('SESSION_SUPPLIERS_OK\n');
} finally {
  await codex.codexShutdownPersistentRuntimes();
  await claude.resetState();
}

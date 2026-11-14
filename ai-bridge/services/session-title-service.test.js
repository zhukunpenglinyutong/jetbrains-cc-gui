import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionTitleRequest, __testing } from './session-title-service.js';

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

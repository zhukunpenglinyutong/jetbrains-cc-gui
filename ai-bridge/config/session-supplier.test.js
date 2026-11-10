import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionClaudeConfig, buildSessionClaudeSettingsOverride, buildSessionCodexConfig, resolveSessionCodexModel, resolveSessionSupplier } from './session-supplier.js';
import { setModelEnvironmentVariables } from '../utils/model-utils.js';
import { buildCodexNativeRuntime, computeCodexRuntimeFingerprint } from '../services/codex/codex-native-runtime-config.js';

const claudeProvider = (name, auth = 'ANTHROPIC_AUTH_TOKEN') => ({
  settingsConfig: { env: {
    [auth]: `fixture-${name}`, ANTHROPIC_BASE_URL: `https://${name}.example.invalid`,
    ANTHROPIC_DEFAULT_SONNET_MODEL: `${name}-sonnet`, ANTHROPIC_DEFAULT_OPUS_MODEL: `${name}-opus`,
    NODE_OPTIONS: '--require forbidden',
  } },
});
const codexProvider = name => ({
  configToml: `model_provider = "${name}"\n[model_providers.${name}]\nname = "${name}"\nbase_url = "https://${name}.example.invalid/v1"\nwire_api = "responses"\n`,
  authJson: JSON.stringify({ OPENAI_API_KEY: `fixture-${name}` }),
});
const config = {
  claude: { current: 'a', providers: { a: claudeProvider('a'), b: claudeProvider('b', 'ANTHROPIC_API_KEY') } },
  codex: { current: 'a', providers: { a: codexProvider('a'), b: codexProvider('b') } },
};

test('concurrent Claude suppliers own credentials, routing and every model tier without process mutation', async () => {
  const original = { ...process.env };
  const beforeConfig = JSON.stringify(config);
  const baseEnv = { PATH: 'fixture-path', ANTHROPIC_AUTH_TOKEN: 'global-token', ANTHROPIC_API_KEY: 'global-key',
    ANTHROPIC_BASE_URL: 'https://global.example.invalid', CLAUDE_CODE_USE_BEDROCK: '1' };
  const [a, b] = await Promise.all(['a', 'b'].map(async id => {
    const result = buildSessionClaudeConfig(id, { config, baseEnv });
    setModelEnvironmentVariables(`${id}-sonnet`, 'claude-sonnet-5', result.settings.env, result.env);
    return result;
  }));
  assert.equal(a.env.ANTHROPIC_AUTH_TOKEN, 'fixture-a');
  assert.equal(a.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(b.env.ANTHROPIC_API_KEY, 'fixture-b');
  assert.equal(b.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(a.env.ANTHROPIC_BASE_URL, 'https://a.example.invalid');
  assert.equal(b.env.ANTHROPIC_BASE_URL, 'https://b.example.invalid');
  assert.equal(a.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'a-opus');
  assert.equal(b.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'b-opus');
  assert.equal(a.env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(a.env.NODE_OPTIONS, undefined);
  assert.notEqual(a.revision, b.revision);
  assert.deepEqual({ ...process.env }, original);
  assert.equal(JSON.stringify(config), beforeConfig);
  assert.equal(baseEnv.ANTHROPIC_AUTH_TOKEN, 'global-token');
});

test('changing the global default never changes an explicit binding; deletion fails closed', () => {
  const changed = structuredClone(config);
  changed.claude.current = 'b';
  assert.equal(buildSessionClaudeConfig('a', { config: changed }).env.ANTHROPIC_AUTH_TOKEN, 'fixture-a');
  delete changed.claude.providers.a;
  for (const id of ['a', '__session_supplier_unavailable__', '__proto__', '']) {
    assert.throws(() => buildSessionClaudeConfig(id, { config: changed }), { code: 'SESSION_SUPPLIER_UNAVAILABLE' });
  }
  assert.equal(resolveSessionSupplier('claude', undefined, { config }), null);
});

test('saved supplier edits change only its runtime revision and child config', () => {
  const changed = structuredClone(config);
  changed.claude.providers.a.settingsConfig.env.ANTHROPIC_AUTH_TOKEN = 'rotated-fixture';
  assert.notEqual(buildSessionClaudeConfig('a', { config }).revision, buildSessionClaudeConfig('a', { config: changed }).revision);
  assert.equal(buildSessionClaudeConfig('b', { config }).revision, buildSessionClaudeConfig('b', { config: changed }).revision);
});

test('Codex suppliers keep native history in the same home while isolating launch config and keys', () => {
  const before = JSON.stringify(config);
  const launch = id => {
    const supplier = buildSessionCodexConfig(id, { config, baseEnv: {} });
    const runtime = buildCodexNativeRuntime({ ...supplier, baseEnv: { CODEX_HOME: '/fixture/shared-history' } });
    return { supplier, runtime };
  };
  const a = launch('a');
  const b = launch('b');
  assert.equal(a.runtime.env.CODEX_HOME, b.runtime.env.CODEX_HOME);
  assert.equal(a.runtime.env.CODEX_API_KEY, 'fixture-a');
  assert.equal(b.runtime.env.CODEX_API_KEY, 'fixture-b');
  const providerId = a.supplier.modelProvider;
  assert.equal(a.runtime.config.model_providers[providerId].base_url, 'https://a.example.invalid/v1');
  assert.equal(b.runtime.config.model_providers[providerId].base_url, 'https://b.example.invalid/v1');
  assert.equal(a.runtime.config.model_providers[providerId].requires_openai_auth, false);
  assert.equal(a.runtime.config.model_providers[providerId].env_key, 'CODEX_API_KEY');
  assert.ok(!JSON.stringify(a.runtime.config).includes('fixture-a'));
  assert.notEqual(computeCodexRuntimeFingerprint(a.supplier), computeCodexRuntimeFingerprint(b.supplier));
  assert.equal(JSON.stringify(config), before);
});

test('native login bindings preserve authorization and cannot silently select another supplier', () => {
  const id = '__codex_cli_login__';
  const dependencies = { config, codexState: () => ({ currentId: id, access: 'cli_login' }) };
  assert.equal(buildSessionCodexConfig(id, dependencies).authMode, 'cli_login');
  assert.throws(() => buildSessionCodexConfig(id, { config, codexState: () => ({ currentId: 'a', access: 'managed' }) }),
    { code: 'SESSION_SUPPLIER_UNAVAILABLE' });
});

test('Codex model aliases follow the selected supplier without leaking plugin metadata to native config', () => {
  const changed = structuredClone(config);
  changed.codex.providers.b.configToml += '\n[model_aliases]\n"gpt-5.5" = "supplier-b-model"\n';
  assert.equal(resolveSessionCodexModel('b', 'gpt-5.5', { config: changed }), 'supplier-b-model');
  assert.equal(resolveSessionCodexModel('a', 'gpt-5.5', { config: changed }), 'gpt-5.5');
  assert.equal(buildSessionCodexConfig('b', { config: changed }).extraConfig.model_aliases, undefined);
});

test('invalid native supplier fragments never disclose parser source or fall back to global credentials', () => {
  for (const provider of [
    { configToml: 'secret_fixture = "unterminated', authJson: '{}' },
    { configToml: '[mcp_servers.fixture]\ncommand="fixture"', authJson: '{"OPENAI_API_KEY":"fixture"}' },
    { configToml: '', authJson: '{"tokens":{"access_token":"fixture"}}' },
  ]) {
    assert.throws(() => buildSessionCodexConfig('invalid', { config: { codex: { providers: { invalid: provider } } }, baseEnv: {} }),
      error => error.code === 'SESSION_SUPPLIER_UNAVAILABLE' && !error.message.includes('secret_fixture'));
  }
});

test('a missing named Codex provider must not silently route its key to OpenAI', () => {
  for (const configToml of ['model_provider="missing"', 'model_provider=42', 'model_provider=""']) {
    const provider = { configToml, authJson: '{"OPENAI_API_KEY":"fixture-custom-key"}' };
    assert.throws(() => buildSessionCodexConfig('invalid', {
      config: { codex: { providers: { invalid: provider } } }, baseEnv: {},
    }), { code: 'SESSION_SUPPLIER_UNAVAILABLE' });
  }
});

test('cloud supplier routing wins over global settings without changing request controls', () => {
  const settingsConfig = { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_ACCESS_KEY_ID: 'fixture-cloud-access',
    AWS_SECRET_ACCESS_KEY: 'fixture-cloud-secret', AWS_REGION: 'fixture-region', MAX_THINKING_TOKENS: '999999',
    NODE_OPTIONS: '--require forbidden' } };
  const supplier = buildSessionClaudeConfig('cloud', { config: { claude: { providers: { cloud: { settingsConfig } } } }, baseEnv: {} });
  const override = buildSessionClaudeSettingsOverride(supplier, {
    env: { ANTHROPIC_MODEL: 'selected-model', MAX_THINKING_TOKENS: '', CLAUDE_CODE_EFFORT_LEVEL: '' },
  });
  // Claude applies settings sources on top of its launch environment. The inline
  // settings layer must agree with this supplier rather than a global profile.
  const effective = { ...supplier.env, CLAUDE_CODE_USE_VERTEX: '1', AWS_SECRET_ACCESS_KEY: 'global-secret',
    ANTHROPIC_AUTH_TOKEN: 'global-token', ANTHROPIC_BASE_URL: 'https://global.example.invalid', ...override.env };
  assert.equal(effective.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(effective.CLAUDE_CODE_USE_VERTEX, '');
  assert.equal(effective.AWS_SECRET_ACCESS_KEY, 'fixture-cloud-secret');
  assert.equal(effective.ANTHROPIC_AUTH_TOKEN, '');
  assert.equal(effective.ANTHROPIC_BASE_URL, '');
  assert.equal(effective.ANTHROPIC_MODEL, 'selected-model');
  assert.equal(effective.MAX_THINKING_TOKENS, '');
  assert.equal(override.env.NODE_OPTIONS, undefined);
  assert.equal(buildSessionClaudeSettingsOverride(null, override), override);
});

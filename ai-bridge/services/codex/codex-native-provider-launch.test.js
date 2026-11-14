import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'smol-toml';
import { buildAppServerArgv, buildCodexProviderLaunchConfig } from './codex-native-runtime-config.js';
import { CodexAppServerClient } from './codex-appserver-client.js';

const launchOverrides = launch => JSON.parse(JSON.stringify(Object.assign({},
  ...launch.configArgs.filter((_, index) => index % 2).map(text => parse(text)))));

test('process startup selects the bound provider and preserves quoted native TOML settings', () => {
  const modelProvider = 'relay.with "quotes"';
  const provider = { name: 'Relay\n线路', base_url: 'https://relay.example.invalid/v1?tag=a&b=c',
    wire_api: 'responses', requires_openai_auth: false, request_max_retries: 3,
    query_params: { 'a.b': 'quote"slash\\tab\t' }, env_key: 'TEAM_KEY' };
  const config = { model_providers: { [modelProvider]: provider }, approval_policy: 'on-request' };
  const launch = buildCodexProviderLaunchConfig({ modelProvider, config, env: { TEAM_KEY: 'fixture-api-secret' } });
  assert.deepEqual(launchOverrides(launch), { model_provider: modelProvider, model_providers: { [modelProvider]: provider } });
  assert.equal(launch.configArgs.join(' ').includes('fixture-api-secret'), false);
  assert.equal(launch.configArgs.join(' ').includes('approval_policy'), false, 'turn controls still use RPC');
  assert.deepEqual(buildAppServerArgv(['node', 'codex.js'], launch.configArgs),
    ['node', 'codex.js', 'app-server', '--listen', 'stdio://', ...launch.configArgs]);
});

test('header credentials stay in the child environment and are redacted from diagnostics', () => {
  const provider = { name: 'Relay', http_headers: { 'X.Fixture-Key': 'fixture-header-secret', Authorization: 'Bearer fixture-token' } };
  const nativeConfig = { model_providers: { bound: provider } };
  const env = { CODEX_HOME: '/fixture/shared-history', ORDINARY: 'visible-fixture-value' };
  const before = structuredClone({ nativeConfig, env });
  const client = new CodexAppServerClient({ command: ['codex'], nativeConfig, modelProvider: 'bound', env });
  const overrides = launchOverrides({ configArgs: client.configArgs });
  const headers = overrides.model_providers.bound.env_http_headers;
  assert.equal(client.env[headers['X.Fixture-Key']], 'fixture-header-secret');
  assert.equal(client.env[headers.Authorization], 'Bearer fixture-token');
  assert.equal(overrides.model_providers.bound.http_headers, undefined);
  for (const secret of Object.values(provider.http_headers)) {
    assert.equal(client.configArgs.join(' ').includes(secret), false);
    assert.equal(client.sanitizeDiagnostic(`failure ${secret}`).includes(secret), false);
  }
  assert.equal(client.sanitizeDiagnostic(env.ORDINARY), env.ORDINARY);
  assert.deepEqual({ nativeConfig, env }, before);
});

test('existing environment headers retain precedence with a static fallback when absent', () => {
  const config = { model_providers: { bound: { name: 'Relay',
    env_http_headers: { 'X-Existing': 'EXISTING_HEADER', 'X-Fallback': 'MISSING_HEADER' },
    http_headers: { 'X-Existing': 'unused-static', 'X-Fallback': 'fixture-fallback' } } } };
  const launch = buildCodexProviderLaunchConfig({ modelProvider: 'bound', config, env: { EXISTING_HEADER: 'fixture-existing' } });
  const headers = launchOverrides(launch).model_providers.bound.env_http_headers;
  assert.equal(headers['X-Existing'], 'EXISTING_HEADER');
  assert.equal(launch.env[headers['X-Existing']], 'fixture-existing');
  assert.equal(launch.env[headers['X-Fallback']], 'fixture-fallback');
  assert.equal(launch.configArgs.join(' ').includes('fixture-fallback'), false);
  assert.equal(launch.configArgs.join(' ').includes('unused-static'), false);
});

test('an experimental bearer token is supplied through env_key without exposing it in argv', () => {
  const launch = buildCodexProviderLaunchConfig({ modelProvider: 'bound', env: {}, config: {
    model_providers: { bound: { name: 'Relay', experimental_bearer_token: 'fixture-bearer-secret' } },
  } });
  const provider = launchOverrides(launch).model_providers.bound;
  assert.equal(launch.env[provider.env_key], 'fixture-bearer-secret');
  assert.equal(provider.experimental_bearer_token, undefined);
  assert.ok(launch.sensitiveEnvNames.includes(provider.env_key));
  assert.equal(launch.configArgs.join(' ').includes('fixture-bearer-secret'), false);
});

test('native login does not override the CLI provider or clone its environment', () => {
  const env = { CODEX_HOME: '/fixture/native-login' };
  assert.deepEqual(buildCodexProviderLaunchConfig({ env, config: { model: 'native-model' } }),
    { configArgs: [], env, sensitiveEnvNames: [] });
  assert.equal(buildCodexProviderLaunchConfig({ env }).env, env);
});

test('invalid provider launch inputs fail before spawning without exposing configuration values', () => {
  assert.throws(() => buildCodexProviderLaunchConfig({ modelProvider: 'missing', config: {} }),
    /Codex provider launch configuration is unavailable/);
  assert.throws(() => buildCodexProviderLaunchConfig({ modelProvider: 'bound', config: {
    model_providers: { bound: { http_headers: { Authorization: { secret: 'fixture-invalid-secret' } } } },
  } }), { message: 'Codex provider header configuration is invalid' });
});

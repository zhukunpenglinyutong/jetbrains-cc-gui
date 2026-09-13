import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectGrokAuthMethodId,
  normalizeAuthMethod,
  buildGrokEnv,
  applyGrokBaseUrlEnv,
  isBareGatewayV1Base,
  parseGrokConfigTomlCredentials,
  resolveEffectiveGrokAuth,
} from './grok-utils.js';

// oauth strip tests must not hit real ~/.grok — inject token present / disable resolve.
const withOAuthToken = { hasOAuthToken: () => true, readConfigCredentials: () => ({ apiKey: '', baseUrl: '' }) };
const noResolve = false;

test('normalizeAuthMethod aliases', () => {
  assert.equal(normalizeAuthMethod('cached_token'), 'oauth');
  assert.equal(normalizeAuthMethod('xai.api_key'), 'api_key');
  assert.equal(normalizeAuthMethod('CLI_LOGIN'), 'oauth');
  assert.equal(normalizeAuthMethod('auto'), 'auto');
});

test('oauth preferred picks cached_token even when api key present', () => {
  const id = selectGrokAuthMethodId({
    authMethods: new Set(['cached_token', 'grok.com', 'xai.api_key']),
    defaultAuth: 'xai.api_key',
    preferred: 'oauth',
    hasApiKey: true,
  });
  assert.equal(id, 'cached_token');
});

test('api_key preferred picks xai.api_key when key present', () => {
  const id = selectGrokAuthMethodId({
    authMethods: new Set(['cached_token', 'xai.api_key']),
    preferred: 'api_key',
    hasApiKey: true,
  });
  assert.equal(id, 'xai.api_key');
});

test('api_key preferred falls back to oauth when no key', () => {
  const id = selectGrokAuthMethodId({
    authMethods: new Set(['cached_token', 'xai.api_key']),
    preferred: 'api_key',
    hasApiKey: false,
  });
  assert.equal(id, 'cached_token');
});

test('auto prefers oauth over api key', () => {
  const id = selectGrokAuthMethodId({
    authMethods: new Set(['cached_token', 'xai.api_key']),
    defaultAuth: 'xai.api_key',
    preferred: 'auto',
    hasApiKey: true,
  });
  assert.equal(id, 'cached_token');
});

test('buildGrokEnv oauth strips API keys', () => {
  const env = buildGrokEnv(
    { XAI_API_KEY: 'secret', GROK_API_KEY: 'secret', PATH: '/bin' },
    'also-secret',
    '',
    'oauth',
    withOAuthToken
  );
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_API_KEY, undefined);
  assert.equal(env.GROK_AUTH_METHOD, 'oauth');
  assert.equal(env.PATH, '/bin');
});

test('buildGrokEnv api_key keeps provided key', () => {
  const env = buildGrokEnv({ PATH: '/bin' }, 'k123', '', 'api_key', noResolve);
  assert.equal(env.XAI_API_KEY, 'k123');
  assert.equal(env.GROK_API_KEY, 'k123');
  assert.equal(env.GROK_AUTH_METHOD, 'api_key');
});

test('buildGrokEnv oauth sets chat-proxy + models base (not XAI_API_BASE_URL)', () => {
  const env = buildGrokEnv(
    { PATH: '/bin' },
    '',
    'https://gw.example.com/grok/v1',
    'oauth',
    withOAuthToken
  );
  assert.equal(env.GROK_CLI_CHAT_PROXY_BASE_URL, 'https://gw.example.com/grok/v1');
  assert.equal(env.GROK_BASE_URL, 'https://gw.example.com/grok/v1');
  assert.equal(env.GROK_MODELS_BASE_URL, 'https://gw.example.com/grok/v1');
  assert.equal(env.GROK_MODELS_LIST_URL, 'https://gw.example.com/grok/v1/models');
  assert.equal(env.XAI_API_BASE_URL, undefined);
});

test('buildGrokEnv api_key sets XAI + chat-proxy + models base', () => {
  const env = buildGrokEnv({ PATH: '/bin' }, 'k', 'https://gw.example.com/xai/v1', 'api_key', noResolve);
  assert.equal(env.XAI_API_BASE_URL, 'https://gw.example.com/xai/v1');
  assert.equal(env.GROK_BASE_URL, 'https://gw.example.com/xai/v1');
  assert.equal(env.GROK_CLI_CHAT_PROXY_BASE_URL, 'https://gw.example.com/xai/v1');
  assert.equal(env.GROK_MODELS_BASE_URL, 'https://gw.example.com/xai/v1');
  assert.equal(env.GROK_MODELS_LIST_URL, 'https://gw.example.com/xai/v1/models');
});

test('buildGrokEnv empty base does not override', () => {
  const env = buildGrokEnv(
    { PATH: '/bin', XAI_API_BASE_URL: 'keep-me' },
    '',
    '',
    'api_key',
    noResolve
  );
  assert.equal(env.XAI_API_BASE_URL, 'keep-me');
  assert.equal(env.GROK_CLI_CHAT_PROXY_BASE_URL, undefined);
  assert.equal(env.GROK_MODELS_BASE_URL, undefined);
});

test('applyGrokBaseUrlEnv auto sets chat-proxy + models + XAI', () => {
  const env = {};
  applyGrokBaseUrlEnv(env, 'auto', 'http://127.0.0.1:18789/grok/v1');
  assert.equal(env.GROK_BASE_URL, 'http://127.0.0.1:18789/grok/v1');
  assert.equal(env.XAI_API_BASE_URL, 'http://127.0.0.1:18789/grok/v1');
  assert.equal(env.GROK_CLI_CHAT_PROXY_BASE_URL, 'http://127.0.0.1:18789/grok/v1');
  assert.equal(env.GROK_MODELS_BASE_URL, 'http://127.0.0.1:18789/grok/v1');
  assert.equal(env.GROK_MODELS_LIST_URL, 'http://127.0.0.1:18789/grok/v1/models');
});

test('isBareGatewayV1Base detects lock path', () => {
  assert.equal(isBareGatewayV1Base('https://gw.example.com/v1'), true);
  assert.equal(isBareGatewayV1Base('https://gw.example.com/v1/'), true);
  assert.equal(isBareGatewayV1Base('https://gw.example.com/xai/v1'), false);
  assert.equal(isBareGatewayV1Base('https://gw.example.com/grok/v1'), false);
  assert.equal(isBareGatewayV1Base(''), false);
});

test('parseGrokConfigTomlCredentials reads default model api_key and base_url', () => {
  const toml = `
[models]
default = "grok"

[model.grok]
model = "grok-4.6"
base_url = "https://fufei.mossx.ai/v1"
api_key = "sk-test-from-config"
api_backend = "responses"
`;
  const creds = parseGrokConfigTomlCredentials(toml);
  assert.equal(creds.profile, 'grok');
  assert.equal(creds.apiKey, 'sk-test-from-config');
  assert.equal(creds.baseUrl, 'https://fufei.mossx.ai/v1');
});

test('parseGrokConfigTomlCredentials supports quoted profile names', () => {
  const toml = `
[models]
default = "my grok"

[model."my grok"]
api_key = "sk-quoted"
base_url = "https://example.com/v1"
`;
  const creds = parseGrokConfigTomlCredentials(toml);
  assert.equal(creds.profile, 'my grok');
  assert.equal(creds.apiKey, 'sk-quoted');
  assert.equal(creds.baseUrl, 'https://example.com/v1');
});

test('resolveEffectiveGrokAuth oauth with token stays oauth and strips key', () => {
  const r = resolveEffectiveGrokAuth({
    preferredAuth: 'oauth',
    apiKey: 'should-not-use',
    baseUrl: '',
    hasOAuthToken: () => true,
    readConfigCredentials: () => ({ apiKey: 'cfg', baseUrl: 'https://cfg' }),
  });
  assert.equal(r.authMethod, 'oauth');
  assert.equal(r.apiKey, '');
  assert.equal(r.fellBackFromOauth, false);
  assert.equal(r.reason, 'oauth-token');
});

test('resolveEffectiveGrokAuth oauth empty falls back to config.toml api_key', () => {
  const r = resolveEffectiveGrokAuth({
    preferredAuth: 'oauth',
    apiKey: '',
    baseUrl: '',
    hasOAuthToken: () => false,
    readConfigCredentials: () => ({
      apiKey: 'sk-from-toml',
      baseUrl: 'https://proxy.example/v1',
      profile: 'grok',
    }),
  });
  assert.equal(r.authMethod, 'api_key');
  assert.equal(r.apiKey, 'sk-from-toml');
  assert.equal(r.baseUrl, 'https://proxy.example/v1');
  assert.equal(r.fellBackFromOauth, true);
  assert.equal(r.reason, 'oauth-empty-fallback-config-api-key');
});

test('resolveEffectiveGrokAuth oauth empty prefers plugin key over config', () => {
  const r = resolveEffectiveGrokAuth({
    preferredAuth: 'oauth',
    apiKey: 'plugin-key',
    baseUrl: 'https://plugin-base/v1',
    hasOAuthToken: () => false,
    readConfigCredentials: () => ({
      apiKey: 'sk-from-toml',
      baseUrl: 'https://proxy.example/v1',
    }),
  });
  assert.equal(r.authMethod, 'api_key');
  assert.equal(r.apiKey, 'plugin-key');
  assert.equal(r.baseUrl, 'https://plugin-base/v1');
  assert.equal(r.fellBackFromOauth, true);
  assert.equal(r.reason, 'oauth-empty-fallback-plugin-api-key');
});

test('resolveEffectiveGrokAuth oauth empty with no key stays oauth for device login', () => {
  const r = resolveEffectiveGrokAuth({
    preferredAuth: 'oauth',
    apiKey: '',
    baseUrl: '',
    hasOAuthToken: () => false,
    readConfigCredentials: () => ({ apiKey: '', baseUrl: '' }),
  });
  assert.equal(r.authMethod, 'oauth');
  assert.equal(r.apiKey, '');
  assert.equal(r.fellBackFromOauth, false);
  assert.equal(r.reason, 'oauth-login-required');
});

test('buildGrokEnv oauth without token falls back and injects config key', () => {
  const env = buildGrokEnv(
    { PATH: '/bin', XAI_API_KEY: 'ambient-should-not-leak-as-oauth' },
    '',
    '',
    'oauth',
    {
      hasOAuthToken: () => false,
      readConfigCredentials: () => ({
        apiKey: 'sk-fallback',
        baseUrl: 'https://fb.example/v1',
      }),
    }
  );
  assert.equal(env.GROK_AUTH_METHOD, 'api_key');
  assert.equal(env.XAI_API_KEY, 'sk-fallback');
  assert.equal(env.GROK_API_KEY, 'sk-fallback');
  assert.equal(env.XAI_API_BASE_URL, 'https://fb.example/v1');
  assert.equal(env.GROK_CLI_CHAT_PROXY_BASE_URL, 'https://fb.example/v1');
});

test('empty auth.json object is not a token', () => {
  // hasGrokOAuthToken uses credentialObjectHasToken via parse — re-test via resolve inject
  const r = resolveEffectiveGrokAuth({
    preferredAuth: 'oauth',
    hasOAuthToken: () => false,
    readConfigCredentials: () => ({ apiKey: 'k', baseUrl: '' }),
  });
  assert.equal(r.authMethod, 'api_key');
});

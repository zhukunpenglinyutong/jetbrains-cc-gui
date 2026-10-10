import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAppServerArgv,
  buildCodexNativeRuntime,
  buildProjectDocFallbackConfig,
  computeCodexRuntimeFingerprint,
  CODEX_MANAGED_API_KEY_ENV,
  CODEX_MANAGED_PROVIDER_ID,
} from './codex-native-runtime-config.js';

const POLLUTED_ENV = {
  PATH: 'C:\\Windows',
  CODEX_APPROVAL_POLICY: 'never',
  CODEX_SANDBOX_MODE: 'danger-full-access',
  codex_sandbox_network_disabled: '1',
  HTTP_PROXY: 'http://127.0.0.1:8080',
  HTTPS_PROXY: 'http://127.0.0.1:8081',
  CC_GUI_CODEX_INHERIT_PROXY: 'true',
  OPENAI_API_KEY: 'sk-managed-secret'
};

test('managed credentials ride the child env and never appear in config strings', () => {
  const runtime = buildCodexNativeRuntime({
    authMode: 'managed',
    apiKey: 'sk-managed-secret',
    baseUrl: 'https://relay.example.com/v1',
    providerLabel: 'Relay Provider',
    baseEnv: { PATH: 'C:\\Windows' }
  });

  assert.equal(runtime.auth.mode, 'managed');
  assert.equal(runtime.auth.credentialInjected, true);
  assert.equal(runtime.env[CODEX_MANAGED_API_KEY_ENV], 'sk-managed-secret');
  assert.equal(runtime.modelProvider, CODEX_MANAGED_PROVIDER_ID);
  const providerEntry = runtime.config.model_providers[CODEX_MANAGED_PROVIDER_ID];
  assert.equal(providerEntry.base_url, 'https://relay.example.com/v1');
  assert.equal(providerEntry.env_key, CODEX_MANAGED_API_KEY_ENV);
  assert.equal(providerEntry.name, 'Relay Provider');
  // The credential must never be serialized into config.
  assert.ok(!JSON.stringify(runtime.config).includes('sk-managed-secret'));
});

test('cli_login never injects credentials and empty values overwrite nothing', () => {
  const runtime = buildCodexNativeRuntime({
    authMode: 'cli_login',
    apiKey: '',
    baseUrl: '',
    baseEnv: { PATH: 'C:\\Windows' }
  });

  assert.equal(runtime.auth.credentialInjected, false);
  assert.equal(runtime.auth.providerConfigured, false);
  assert.equal(runtime.env[CODEX_MANAGED_API_KEY_ENV], undefined);
  assert.equal(runtime.modelProvider, null);
  assert.deepEqual(runtime.config.project_doc_fallback_filenames, ['CLAUDE.md']);
});

test('empty managed apiKey does not clobber an existing env value', () => {
  const runtime = buildCodexNativeRuntime({
    authMode: 'managed',
    apiKey: '',
    baseUrl: '',
    baseEnv: { PATH: 'C:\\Windows', [CODEX_MANAGED_API_KEY_ENV]: 'sk-keep-me' }
  });

  assert.equal(runtime.env[CODEX_MANAGED_API_KEY_ENV], 'sk-keep-me');
  assert.equal(runtime.auth.credentialInjected, false, 'no injection happened');
});

test('polluted CODEX_ variables are removed from the child env in both modes', () => {
  for (const authMode of ['managed', 'cli_login']) {
    const runtime = buildCodexNativeRuntime({
      authMode,
      apiKey: 'sk-x',
      baseUrl: 'https://relay.example.com/v1',
      baseEnv: POLLUTED_ENV
    });

    const keys = Object.keys(runtime.env).map((key) => key.toUpperCase());
    assert.ok(!keys.includes('CODEX_APPROVAL_POLICY'), `${authMode}: approval pollution removed`);
    assert.ok(!keys.includes('CODEX_SANDBOX_MODE'), `${authMode}: sandbox pollution removed`);
    assert.ok(!keys.includes('CODEX_SANDBOX_NETWORK_DISABLED'), `${authMode}: network flag removed`);
    // Proxy variables survive thanks to the explicit opt-in.
    assert.equal(runtime.env.HTTP_PROXY, 'http://127.0.0.1:8080');
    assert.equal(runtime.env.HTTPS_PROXY, 'http://127.0.0.1:8081');
    assert.ok(runtime.removedEnvKeys.includes('CODEX_SANDBOX_MODE'));
  }
});

test('proxy variables stay removed without the opt-in', () => {
  const runtime = buildCodexNativeRuntime({
    authMode: 'managed',
    apiKey: 'sk-x',
    baseEnv: {
      PATH: 'C:\\Windows',
      HTTP_PROXY: 'http://127.0.0.1:8080',
      HTTPS_PROXY: 'http://127.0.0.1:8081'
    }
  });

  assert.equal(runtime.env.HTTP_PROXY, undefined);
  assert.equal(runtime.env.HTTPS_PROXY, undefined);
});

test('custom headers land in the native http_headers entry', () => {
  const runtime = buildCodexNativeRuntime({
    authMode: 'managed',
    apiKey: 'sk-x',
    headers: { 'X-Custom-Trace': 'fixture-value' },
    baseEnv: { PATH: 'C:\\Windows' }
  });

  assert.equal(runtime.auth.providerConfigured, true);
  const providerEntry = runtime.config.model_providers[CODEX_MANAGED_PROVIDER_ID];
  assert.equal(providerEntry.http_headers['X-Custom-Trace'], 'fixture-value');
});

test('a managed API key without an endpoint still selects its env_key provider', () => {
  const runtime = buildCodexNativeRuntime({
    authMode: 'managed',
    apiKey: 'sk-x',
    baseEnv: { PATH: 'C:\\Windows' }
  });

  assert.equal(runtime.modelProvider, CODEX_MANAGED_PROVIDER_ID);
  assert.deepEqual(runtime.config.project_doc_fallback_filenames, ['CLAUDE.md']);
  assert.equal(runtime.auth.credentialInjected, true);
  assert.equal(runtime.auth.providerConfigured, true);
});

test('extra native config entries are merged without dropping provider setup', () => {
  const runtime = buildCodexNativeRuntime({
    authMode: 'managed',
    apiKey: 'sk-x',
    baseUrl: 'https://relay.example.com/v1',
    extraConfig: { approvals_reviewer: 'user' },
    baseEnv: { PATH: 'C:\\Windows' }
  });

  assert.equal(runtime.config.approvals_reviewer, 'user');
  assert.ok(runtime.config.model_providers[CODEX_MANAGED_PROVIDER_ID]);
});

test('project instruction fallback is native config, never prompt text', () => {
  const config = buildProjectDocFallbackConfig(
    { project_doc_fallback_filenames: ['TEAM.md'] },
    ['CUSTOM.md', 'CLAUDE.md'],
  );
  assert.deepEqual(config.project_doc_fallback_filenames, ['TEAM.md', 'CUSTOM.md', 'CLAUDE.md']);
  const runtime = buildCodexNativeRuntime({
    authMode: 'cli_login',
    projectDocFallbackFilenames: ['TEAM.md'],
    baseEnv: { PATH: 'C:\\Windows' },
  });
  assert.deepEqual(runtime.config.project_doc_fallback_filenames, ['TEAM.md', 'CLAUDE.md']);
  assert.equal(JSON.stringify(runtime.config).includes('AGENTS.md'), false);
});

test('transport argv spawns the app-server over stdio exactly once', () => {
  assert.deepEqual(
    buildAppServerArgv(['C:\\tools\\codex.exe']),
    ['C:\\tools\\codex.exe', 'app-server', '--listen', 'stdio://']
  );
  assert.deepEqual(
    buildAppServerArgv(['node', '/tools/codex.js']),
    ['node', '/tools/codex.js', 'app-server', '--listen', 'stdio://']
  );
});

test('fingerprint rebuilds on provider or credential change only', () => {
  const base = {
    authMode: 'managed',
    apiKey: 'sk-secret-1',
    baseUrl: 'https://relay.example.com/v1',
    providerLabel: 'Relay',
    codexHome: 'C:\\fixture\\.codex'
  };
  const fingerprint = computeCodexRuntimeFingerprint(base);

  // Identical inputs → identical fingerprint.
  assert.equal(computeCodexRuntimeFingerprint({ ...base }), fingerprint);

  // Credential change → rebuild.
  assert.notEqual(
    computeCodexRuntimeFingerprint({ ...base, apiKey: 'sk-secret-2' }),
    fingerprint
  );

  // Endpoint change → rebuild.
  assert.notEqual(
    computeCodexRuntimeFingerprint({ ...base, baseUrl: 'https://other.example.com/v1' }),
    fingerprint
  );

  // Provider label change → rebuild.
  assert.notEqual(
    computeCodexRuntimeFingerprint({ ...base, providerLabel: 'Other Relay' }),
    fingerprint
  );

  // Auth mode change → rebuild.
  assert.notEqual(
    computeCodexRuntimeFingerprint({ ...base, authMode: 'cli_login' }),
    fingerprint
  );

  // Native home change → rebuild.
  assert.notEqual(
    computeCodexRuntimeFingerprint({ ...base, codexHome: 'C:\\other\\.codex' }),
    fingerprint
  );
});

test('fingerprint is insensitive to per-turn settings and key order', () => {
  const fingerprint = computeCodexRuntimeFingerprint({
    authMode: 'managed',
    apiKey: 'sk-secret-1',
    baseUrl: 'https://relay.example.com/v1',
    headers: { 'X-A': '1', 'X-B': '2' }
  });

  // Model/effort-like values are not fingerprint inputs; per-turn settings
  // travel via RPC. Header key order must not matter either.
  assert.equal(
    computeCodexRuntimeFingerprint({
      authMode: 'managed',
      apiKey: 'sk-secret-1',
      baseUrl: 'https://relay.example.com/v1',
      headers: { 'X-B': '2', 'X-A': '1' }
    }),
    fingerprint
  );
});

test('fingerprint rebuilds when native project fallback names change', () => {
  const base = computeCodexRuntimeFingerprint({
    authMode: 'cli_login',
    projectDocFallbackFilenames: ['TEAM.md'],
  });
  assert.notEqual(
    computeCodexRuntimeFingerprint({
      authMode: 'cli_login',
      projectDocFallbackFilenames: ['OTHER.md'],
    }),
    base,
  );
});

test('fingerprint never contains credential plaintext', () => {
  const fingerprint = computeCodexRuntimeFingerprint({
    authMode: 'managed',
    apiKey: 'sk-super-secret-value',
    baseUrl: 'https://relay.example.com/v1'
  });
  assert.ok(!fingerprint.includes('sk-super-secret-value'));
  assert.match(fingerprint, /^[0-9a-f]{64}$/);

  // Absent vs present credentials differ (rebuild boundary is observable).
  assert.notEqual(
    computeCodexRuntimeFingerprint({ authMode: 'managed', apiKey: null }),
    computeCodexRuntimeFingerprint({ authMode: 'managed', apiKey: 'sk-x' })
  );
});

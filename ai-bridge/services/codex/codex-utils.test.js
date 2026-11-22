import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexCliEnvironment,
  CODEX_CLI_RECOMMENDED_MIN_VERSION,
  isCodexCliOutdated,
  parseCodexCliVersion,
  normalizeCodexPermissionMode,
} from './codex-utils.js';

test('removes inherited proxy variables by default', () => {
  const result = buildCodexCliEnvironment({
    HTTP_PROXY: 'http://127.0.0.1:8080',
    https_proxy: 'http://127.0.0.1:8081',
    ALL_PROXY: 'socks5://127.0.0.1:1080',
    NPM_CONFIG_PROXY: 'http://127.0.0.1:8082',
    NPM_CONFIG_HTTPS_PROXY: 'http://127.0.0.1:8083',
    PATH: 'C:\\Windows'
  });

  assert.deepEqual(result.cliEnv, { PATH: 'C:\\Windows' });
  assert.deepEqual(result.removedKeys, [
    'HTTP_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'NPM_CONFIG_PROXY',
    'NPM_CONFIG_HTTPS_PROXY'
  ]);
});

test('keeps proxy variables after explicit opt-in', () => {
  const result = buildCodexCliEnvironment({
    cc_gui_codex_inherit_proxy: 'true',
    HTTP_PROXY: 'http://proxy.example:8080',
    HTTPS_PROXY: 'http://proxy.example:8080'
  });

  assert.deepEqual(result.cliEnv, {
    HTTP_PROXY: 'http://proxy.example:8080',
    HTTPS_PROXY: 'http://proxy.example:8080'
  });
  assert.deepEqual(result.removedKeys, ['cc_gui_codex_inherit_proxy']);
});

test('does not enable proxy inheritance for false-like values', () => {
  const result = buildCodexCliEnvironment({
    CC_GUI_CODEX_INHERIT_PROXY: 'false',
    HTTP_PROXY: 'http://proxy.example:8080'
  });

  assert.deepEqual(result.cliEnv, {});
  assert.deepEqual(result.removedKeys, [
    'CC_GUI_CODEX_INHERIT_PROXY',
    'HTTP_PROXY'
  ]);
});

test('removes Codex policy variables regardless of key casing', () => {
  const result = buildCodexCliEnvironment({
    codex_approval_policy: 'never',
    CoDeX_SaNdBoX: 'danger-full-access',
    SAFE_VALUE: 'kept'
  });

  assert.deepEqual(result.cliEnv, { SAFE_VALUE: 'kept' });
  assert.deepEqual(result.removedKeys, ['codex_approval_policy', 'CoDeX_SaNdBoX']);
});

test('normalizes native auto mode casing and aliases before dispatch', () => {
  assert.equal(normalizeCodexPermissionMode('AUTO'), 'auto');
  assert.equal(normalizeCodexPermissionMode(' auto '), 'auto');
  assert.equal(normalizeCodexPermissionMode('AUTOEDIT'), 'acceptEdits');
  assert.equal(normalizeCodexPermissionMode(' AutoEdit '), 'acceptEdits');
});

test('reads the CLI version from the initialize user agent', () => {
  assert.equal(parseCodexCliVersion('codemoss_intellij/0.164.0 (Mac OS 27.0.1; arm64) unknown (codemoss_intellij; 0.6.4)'), '0.164.0');
  assert.equal(parseCodexCliVersion('probe/0.123.0 (Alpine Linux 3.24.3; aarch64) unknown'), '0.123.0');
  assert.equal(parseCodexCliVersion('codex_cli_rs/0.165.0-alpha.2 (Windows 11; x86_64)'), '0.165.0');
});

test('treats a user agent without a proven release version as unknown', () => {
  assert.equal(parseCodexCliVersion('codex-test-peer/1.0'), null);
  assert.equal(parseCodexCliVersion('codex_cli_rs/0.0.0 (Mac OS 27.0.1; arm64) unknown'), null);
  assert.equal(parseCodexCliVersion('no version here'), null);
  assert.equal(parseCodexCliVersion(''), null);
  assert.equal(parseCodexCliVersion(undefined), null);
});

test('flags only a proven CLI version below the recommended minimum', () => {
  assert.equal(CODEX_CLI_RECOMMENDED_MIN_VERSION, '0.160.0');
  assert.equal(isCodexCliOutdated('0.123.0'), true);
  assert.equal(isCodexCliOutdated('0.159.9'), true);
  assert.equal(isCodexCliOutdated('0.160.0'), false);
  assert.equal(isCodexCliOutdated('0.164.0'), false);
  assert.equal(isCodexCliOutdated('1.0.0'), false);
  assert.equal(isCodexCliOutdated(null), false);
  assert.equal(isCodexCliOutdated('not-a-version'), false);
});

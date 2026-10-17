import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  resolveZcodeCliPath,
  resolveActiveProvider,
  providerModels,
  buildZcodeCredentialEnv,
  buildRuntimeModel,
} from './zcode-config.js';

test('finds the Linux package app-server entry', () => {
  const entry = '/opt/ZCode/resources/glm/zcode.cjs';
  assert.equal(resolveZcodeCliPath('linux', {}, (path) => path === entry), resolve(entry));
});

test('preserves the legacy Linux app subdirectory layout', () => {
  const entry = '/opt/ZCode/app/resources/glm/zcode.cjs';
  assert.equal(resolveZcodeCliPath('linux', {}, (path) => path === entry), resolve(entry));
});

test('prefers the Linux package entry when both layouts exist', () => {
  assert.equal(resolveZcodeCliPath('linux', {}, () => true), resolve('/opt/ZCode/resources/glm/zcode.cjs'));
});

test('explicit entries take precedence over defaults and trim surrounding whitespace', () => {
  assert.equal(resolveZcodeCliPath('linux', { ZCODE_CLI_PATH: '  /custom/zcode.cjs  ' }, () => true),
    resolve('/custom/zcode.cjs'));
});

test('finds the Linux package entry when the explicit entry is missing', () => {
  const entry = '/opt/ZCode/resources/glm/zcode.cjs';
  assert.equal(resolveZcodeCliPath('linux', { ZCODE_CLI_PATH: '/missing/zcode.cjs' }, (path) => path === entry), resolve(entry));
});

test('returns null when no entry is installed or configured', () => {
  assert.equal(resolveZcodeCliPath('linux', {}, () => false), null);
  assert.equal(resolveZcodeCliPath('linux', { ZCODE_CLI_PATH: '  ' }, () => false), null);
});

test('preserves the macOS app bundle entry', () => {
  const entry = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
  assert.equal(resolveZcodeCliPath('darwin', {}, (path) => path === entry), resolve(entry));
});

test('preserves Windows per-user and system-wide install locations', () => {
  const env = { LOCALAPPDATA: '/local', ProgramFiles: '/programs', 'ProgramFiles(x86)': '/programs-x86' };
  for (const entry of [
    join(env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    join(env.ProgramFiles, 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    join(env['ProgramFiles(x86)'], 'ZCode', 'resources', 'glm', 'zcode.cjs'),
  ]) {
    assert.equal(resolveZcodeCliPath('win32', env, (path) => path === entry), resolve(entry));
  }
  assert.equal(resolveZcodeCliPath('win32', {}, () => true), null);
});

function makeCliFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'zcode-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, 'zcode.cjs');
  writeFileSync(entry, '// Fixture only; discovery must not execute this file.\n');
  return { root, entry };
}

// Omit Windows install roots so real-filesystem tests cannot pick up the host's installed bundle.
test('honors ZCODE_PATH and ignores blank primary overrides', (t) => {
  const { entry } = makeCliFixture(t);
  assert.equal(resolveZcodeCliPath('win32', { ZCODE_PATH: `  ${entry}  ` }), entry);
  assert.equal(resolveZcodeCliPath('win32', { ZCODE_CLI_PATH: '  ', ZCODE_PATH: entry }), entry);
});

test('tries ZCODE_PATH after a missing or directory primary override', (t) => {
  const { root, entry } = makeCliFixture(t);
  for (const primary of [join(root, 'missing.cjs'), root]) {
    assert.equal(resolveZcodeCliPath('win32', { ZCODE_CLI_PATH: primary, ZCODE_PATH: entry }), entry);
  }
});

test('prefers a valid primary override over ZCODE_PATH', (t) => {
  const { root, entry } = makeCliFixture(t);
  const alternate = join(root, 'alternate.cjs');
  writeFileSync(alternate, '// Alternate fixture.\n');
  assert.equal(resolveZcodeCliPath('win32', { ZCODE_CLI_PATH: entry, ZCODE_PATH: alternate }), entry);
});

test('rejects directory and missing overrides when no bundle exists', (t) => {
  const { root } = makeCliFixture(t);
  for (const key of ['ZCODE_CLI_PATH', 'ZCODE_PATH']) {
    assert.equal(resolveZcodeCliPath('win32', { [key]: root }), null);
    assert.equal(resolveZcodeCliPath('win32', { [key]: join(root, 'missing.cjs') }), null);
  }
});

test('skips a directory override in favor of an existing bundle entry', (t) => {
  const { root } = makeCliFixture(t);
  const entry = join(root, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs');
  mkdirSync(join(root, 'Programs', 'ZCode', 'resources', 'glm'), { recursive: true });
  writeFileSync(entry, '// Bundled fixture.\n');
  assert.equal(resolveZcodeCliPath('win32', { ZCODE_CLI_PATH: root, LOCALAPPDATA: root }), entry);
});

test('rejects directories named zcode.cjs inside bundle locations', (t) => {
  const { root } = makeCliFixture(t);
  mkdirSync(join(root, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'), { recursive: true });
  assert.equal(resolveZcodeCliPath('win32', { LOCALAPPDATA: root }), null);
});

test('makes relative overrides independent of the child workspace', (t) => {
  const { entry } = makeCliFixture(t);
  const relativeEntry = relative(process.cwd(), entry);
  assert.equal(resolveZcodeCliPath('win32', { ZCODE_CLI_PATH: relativeEntry }), entry);
});

const CONFIG = {
  provider: {
    'builtin:bigmodel-coding-plan': {
      kind: 'anthropic',
      name: 'BigModel - Coding Plan',
      enabled: true,
      options: { baseURL: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'k-plan' },
      models: {
        'GLM-5.3': { name: 'GLM-5.3', limit: { context: 1000000, output: 128000 }, modalities: { input: ['text'] } },
        'GLM-5-Turbo': { name: 'glm-5-turbo', limit: { context: 200000, output: 128000 } },
      },
    },
    'builtin:zai': {
      kind: 'anthropic',
      enabled: false,
      options: { baseURL: 'https://api.z.ai/api/anthropic', apiKey: '' },
      models: { 'GLM-5.3': {} },
    },
  },
};

const SETTINGS = {
  providerFamilyDomain: 'bigmodel',
  modelProviderFamilySelectedKeys: { bigmodel: 'coding-plan:builtin:bigmodel-coding-plan' },
};

test('active provider follows the family-selected key', () => {
  const active = resolveActiveProvider(CONFIG, SETTINGS);
  assert.equal(active.providerId, 'builtin:bigmodel-coding-plan');
  assert.equal(active.apiKey, 'k-plan');
  assert.equal(active.baseURL, 'https://open.bigmodel.cn/api/anthropic');
});

test('disabled selected provider falls back to first enabled with key', () => {
  const config = structuredClone(CONFIG);
  config.provider['builtin:bigmodel-coding-plan'].enabled = false;
  config.provider['builtin:zai'].enabled = true;
  config.provider['builtin:zai'].options.apiKey = 'k-zai';
  const active = resolveActiveProvider(config, SETTINGS);
  assert.equal(active.providerId, 'builtin:zai');
  assert.equal(active.apiKey, 'k-zai');
});

test('oauth-only provider (no key) yields no credential env', () => {
  const config = structuredClone(CONFIG);
  config.provider['builtin:bigmodel-coding-plan'].options.apiKey = '';
  const active = resolveActiveProvider(config, SETTINGS);
  // selected provider has no key; fallback loop also finds none with a key
  assert.equal(buildZcodeCredentialEnv(active).ANTHROPIC_API_KEY, undefined);
});

test('credential env carries model/base/key when a key exists', () => {
  const env = buildZcodeCredentialEnv(resolveActiveProvider(CONFIG, SETTINGS));
  assert.equal(env.ZCODE_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(env.ANTHROPIC_API_KEY, 'k-plan');
  assert.equal(env.ZCODE_MODEL, 'GLM-5.3');
});

test('providerModels maps limit/modalities', () => {
  const active = resolveActiveProvider(CONFIG, SETTINGS);
  const models = providerModels(active);
  assert.equal(models.length, 2);
  const glm = models.find((m) => m.id === 'GLM-5.3');
  assert.equal(glm.contextWindow, 1000000);
  assert.equal(glm.supportsImages, false);
});

test('no config yields null active provider', () => {
  assert.equal(resolveActiveProvider(null, null), null);
});

test('runtimeModel carries the full provider definition', () => {
  const active = resolveActiveProvider(CONFIG, SETTINGS);
  const rt = buildRuntimeModel('GLM-5-Turbo', active);
  assert.equal(rt.model.providerId, 'builtin:bigmodel-coding-plan');
  assert.equal(rt.model.modelId, 'GLM-5-Turbo');
  assert.equal(rt.provider.kind, 'anthropic');
  assert.equal(rt.provider.source, 'builtin');
  assert.equal(rt.provider.baseURL, 'https://open.bigmodel.cn/api/anthropic');
  assert.deepEqual(rt.provider.apiKey, { source: 'inline', value: 'k-plan' });
  // every model of the provider embedded with limits (context window must not zero out)
  const turbo = rt.provider.models.find((m) => m.modelId === 'GLM-5-Turbo');
  assert.equal(turbo.contextWindow, 200000);
  assert.equal(rt.provider.models.length, 2);
});

test('runtimeModel source is custom for non-builtin providers', () => {
  const active = { providerId: 'thirdparty:abc', name: 'X', baseURL: 'https://x', apiKey: 'k', models: { M1: {} } };
  const rt = buildRuntimeModel('M1', active);
  assert.equal(rt.provider.source, 'custom');
});

test('runtimeModel is null without provider or model', () => {
  assert.equal(buildRuntimeModel('GLM-5.3', null), null);
  const active = resolveActiveProvider(CONFIG, SETTINGS);
  assert.equal(buildRuntimeModel('', active), null);
  assert.equal(buildRuntimeModel('GLM-5.3', { ...active, models: {} }), null);
});

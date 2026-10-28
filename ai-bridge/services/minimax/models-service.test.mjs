import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMiniMaxModelsFromYaml, resolveMiniMaxConfigPaths } from './models-service.js';

// Model entries in config.yaml are block mappings (properties on the lines
// below), matching the real mcode config layout.
const CONFIG = `
provider:
  minimax:
    name: MiniMax
    models:
      MiniMax-M2.7:
        context_window: 200000
      MiniMax-M3:
        context_window: 1000000
custom_provider:
  provider-abc:
    name: Acme Gateway
    enabled: true
    models:
      acme-pro:
        context_window: 128000
      7b-instruct:
        context_window: 32000
defaultModel: minimax/MiniMax-M3
`;

test('parses official and custom-provider models with refs and labels', () => {
  const { defaultModel, models } = parseMiniMaxModelsFromYaml(CONFIG);
  assert.equal(defaultModel, 'minimax/MiniMax-M3');
  assert.deepEqual(
    models.map((m) => m.id),
    ['minimax/MiniMax-M2.7', 'minimax/MiniMax-M3', 'custom_provider:provider-abc/acme-pro', 'custom_provider:provider-abc/7b-instruct'],
  );
  const custom = models.find((m) => m.id === 'custom_provider:provider-abc/7b-instruct');
  assert.equal(custom.label, 'Acme Gateway / 7b-instruct');
});

test('model ids starting with a digit are not skipped', () => {
  const { models } = parseMiniMaxModelsFromYaml(`
custom_provider:
  provider-x:
    models:
      360-gpt:
        context_window: 64000
`);
  assert.deepEqual(models.map((m) => m.id), ['custom_provider:provider-x/360-gpt']);
});

test('empty or unrelated yaml yields no models and null default', () => {
  assert.deepEqual(parseMiniMaxModelsFromYaml(''), { defaultModel: null, models: [] });
  assert.deepEqual(parseMiniMaxModelsFromYaml('other:\n  key: value\n'), { defaultModel: null, models: [] });
});

test('duplicate model refs are deduplicated', () => {
  const { models } = parseMiniMaxModelsFromYaml(`
provider:
  minimax:
    models:
      MiniMax-M3:
        a: 1
      MiniMax-M3:
        b: 2
`);
  assert.equal(models.length, 1);
});

test('MINIMAX_DATA_DIR relocates config discovery before the ~/.minimax default', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-gui-mm-datadir-'));
  writeFileSync(join(dataDir, 'config.yaml'), 'provider:\n  minimax:\n    models:\n      MiniMax-M3:\n        a: 1\n');
  const saved = { ...process.env };
  try {
    process.env.MINIMAX_DATA_DIR = dataDir;
    const paths = resolveMiniMaxConfigPaths();
    assert.equal(paths[0], join(dataDir, 'config.yaml'));
  } finally {
    for (const key of ['MINIMAX_DATA_DIR', 'MINIMAX_CODE_HOME', 'MINIMAX_HOME']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('plugin overrides still outrank MINIMAX_DATA_DIR', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-gui-mm-datadir2-'));
  writeFileSync(join(dataDir, 'config.yaml'), '');
  const overrideHome = mkdtempSync(join(tmpdir(), 'cc-gui-mm-override-'));
  writeFileSync(join(overrideHome, 'config.yaml'), '');
  const saved = { ...process.env };
  try {
    process.env.MINIMAX_DATA_DIR = dataDir;
    process.env.MINIMAX_CODE_HOME = overrideHome;
    const paths = resolveMiniMaxConfigPaths();
    assert.equal(paths[0], join(overrideHome, 'config.yaml'));
    assert.ok(paths.includes(join(dataDir, 'config.yaml')));
  } finally {
    for (const key of ['MINIMAX_DATA_DIR', 'MINIMAX_CODE_HOME', 'MINIMAX_HOME']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

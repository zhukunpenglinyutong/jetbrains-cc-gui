import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  parseCodexConfigToml,
  parseModelCatalogJson,
  listModels,
} from './models-service.js';

// --- parseCodexConfigToml ------------------------------------------------

test('parseCodexConfigToml extracts top-level keys', () => {
  const toml = `disable_response_storage = true
model = "kimi-k3"
model_reasoning_effort = "high"
model_provider = "custom"
model_catalog_json = "cc-switch-model-catalog.json"

[model_providers.custom]
base_url = "https://api.kimi.com/coding/v1"
name = "kimi_coding"
wire_api = "responses"
`;
  const parsed = parseCodexConfigToml(toml);
  assert.equal(parsed.model, 'kimi-k3');
  assert.equal(parsed.modelProvider, 'custom');
  assert.equal(parsed.modelCatalogJson, 'cc-switch-model-catalog.json');
});

test('parseCodexConfigToml ignores same-named keys inside sections', () => {
  const toml = `model = "top-level"

[model_providers.custom]
model = "section-level"
model_catalog_json = "section-catalog.json"
`;
  const parsed = parseCodexConfigToml(toml);
  assert.equal(parsed.model, 'top-level');
  assert.equal(parsed.modelCatalogJson, null);
});

test('parseCodexConfigToml tolerates single-quoted literal strings', () => {
  const parsed = parseCodexConfigToml(`model = 'kimi-k3'\nmodel_provider = 'custom'\n`);
  assert.equal(parsed.model, 'kimi-k3');
  assert.equal(parsed.modelProvider, 'custom');
});

test('parseCodexConfigToml returns nulls for missing keys / empty input', () => {
  const parsed = parseCodexConfigToml('disable_response_storage = true\n');
  assert.equal(parsed.model, null);
  assert.equal(parsed.modelProvider, null);
  assert.equal(parsed.modelCatalogJson, null);
  assert.deepEqual(parseCodexConfigToml(''), {
    model: null,
    modelProvider: null,
    modelCatalogJson: null,
  });
  assert.deepEqual(parseCodexConfigToml(null), {
    model: null,
    modelProvider: null,
    modelCatalogJson: null,
  });
});

// --- parseModelCatalogJson ----------------------------------------------

test('parseModelCatalogJson parses the cc-switch {models: [...]} shape', () => {
  const catalog = JSON.stringify({
    models: [
      {
        slug: 'kimi-k3',
        display_name: 'kimi-k3',
        description: 'Moonshot Kimi K3',
        priority: 1000,
        visibility: 'list',
      },
    ],
  });
  assert.deepEqual(parseModelCatalogJson(catalog), [
    { id: 'kimi-k3', label: 'kimi-k3', description: 'Moonshot Kimi K3' },
  ]);
});

test('parseModelCatalogJson accepts a root array', () => {
  const catalog = JSON.stringify([
    { slug: 'a', display_name: 'Model A' },
    { id: 'b', name: 'Model B' },
  ]);
  assert.deepEqual(parseModelCatalogJson(catalog), [
    { id: 'a', label: 'Model A', description: undefined },
    { id: 'b', label: 'Model B', description: undefined },
  ]);
});

test('parseModelCatalogJson accepts an id -> meta map', () => {
  const catalog = JSON.stringify({
    'kimi-k3': { display_name: 'Kimi K3', description: 'mapped model' },
  });
  assert.deepEqual(parseModelCatalogJson(catalog), [
    { id: 'kimi-k3', label: 'Kimi K3', description: 'mapped model' },
  ]);
});

test('parseModelCatalogJson filters non-list visibility and sorts by priority desc', () => {
  const catalog = JSON.stringify({
    models: [
      { slug: 'low', priority: 10, visibility: 'list' },
      { slug: 'hidden-model', priority: 9999, visibility: 'hidden' },
      { slug: 'high', priority: 1000, visibility: 'list' },
      { slug: 'mid', priority: 100 },
    ],
  });
  assert.deepEqual(
    parseModelCatalogJson(catalog).map((m) => m.id),
    ['high', 'mid', 'low'],
  );
});

test('parseModelCatalogJson dedupes and skips invalid entries', () => {
  const catalog = JSON.stringify({
    models: [
      { slug: 'a' },
      { slug: 'a', display_name: 'dupe' },
      { slug: '' },
      { display_name: 'no id' },
      null,
      'not-an-object',
    ],
  });
  assert.deepEqual(parseModelCatalogJson(catalog), [
    { id: 'a', label: 'a', description: undefined },
  ]);
});

test('parseModelCatalogJson returns [] for invalid JSON / wrong shapes', () => {
  assert.deepEqual(parseModelCatalogJson('not json'), []);
  assert.deepEqual(parseModelCatalogJson('42'), []);
  assert.deepEqual(parseModelCatalogJson('"str"'), []);
  assert.deepEqual(parseModelCatalogJson('{}'), []);
});

// --- listModels (integration via CODEX_HOME temp dirs) -------------------

function withCodexHome(configToml, catalogJson, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
  try {
    writeFileSync(join(dir, 'config.toml'), configToml);
    if (catalogJson !== null) {
      writeFileSync(join(dir, 'catalog.json'), catalogJson);
    }
    const prevHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    const logs = [];
    const prevLog = console.log;
    console.log = (line) => logs.push(line);
    try {
      fn();
    } finally {
      console.log = prevLog;
      if (prevHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevHome;
    }
    return logs.map((line) => JSON.parse(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('listModels returns catalog models with default pinned first', () => {
  const toml = `model = "kimi-k3"
model_provider = "custom"
model_catalog_json = "catalog.json"
`;
  const catalog = JSON.stringify({
    models: [
      { slug: 'other-model', display_name: 'Other', priority: 10, visibility: 'list' },
      { slug: 'kimi-k3', display_name: 'Kimi K3', priority: 1000, visibility: 'list' },
    ],
  });
  const [payload] = withCodexHome(toml, catalog, () => listModels());
  assert.equal(payload.success, true);
  assert.equal(payload.provider, 'codex');
  assert.equal(payload.defaultModel, 'kimi-k3');
  assert.deepEqual(payload.models.map((m) => m.id), ['kimi-k3', 'other-model']);
});

test('listModels unshifts default model missing from the catalog', () => {
  const toml = `model = "kimi-k3"
model_provider = "custom"
model_catalog_json = "catalog.json"
`;
  const catalog = JSON.stringify({ models: [{ slug: 'other-model' }] });
  const [payload] = withCodexHome(toml, catalog, () => listModels());
  assert.deepEqual(payload.models.map((m) => m.id), ['kimi-k3', 'other-model']);
});

test('listModels with custom provider and no catalog returns only the default', () => {
  const toml = `model = "kimi-k3"
model_provider = "custom"
`;
  const [payload] = withCodexHome(toml, null, () => listModels());
  assert.equal(payload.success, true);
  assert.deepEqual(payload.models, [{ id: 'kimi-k3', label: 'kimi-k3' }]);
  assert.equal(payload.defaultModel, 'kimi-k3');
});

test('listModels with missing catalog file falls back to custom-provider rule', () => {
  const toml = `model = "kimi-k3"
model_provider = "custom"
model_catalog_json = "does-not-exist.json"
`;
  const [payload] = withCodexHome(toml, null, () => listModels());
  assert.equal(payload.success, true);
  assert.deepEqual(payload.models, [{ id: 'kimi-k3', label: 'kimi-k3' }]);
});

test('listModels with official provider returns empty models for frontend fallback', () => {
  const toml = `model = "gpt-5.6-sol"
model_provider = "openai"
`;
  const [payload] = withCodexHome(toml, null, () => listModels());
  assert.equal(payload.success, true);
  assert.deepEqual(payload.models, []);
  assert.equal(payload.defaultModel, 'gpt-5.6-sol');
});

test('listModels without config.toml returns empty success payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
  try {
    const prevHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    const logs = [];
    const prevLog = console.log;
    console.log = (line) => logs.push(line);
    try {
      listModels();
    } finally {
      console.log = prevLog;
      if (prevHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevHome;
    }
    const payload = JSON.parse(logs[0]);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.models, []);
    assert.equal(payload.defaultModel, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

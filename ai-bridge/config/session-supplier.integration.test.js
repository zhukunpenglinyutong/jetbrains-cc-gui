import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('actual Claude request contexts and concurrent Codex native peers honor session supplier bindings', async () => {
  const fixtureHome = mkdtempSync(join(tmpdir(), 'ccgui-session-suppliers-'));
  assert.ok(resolve(fixtureHome).startsWith(resolve(tmpdir()) + sep));
  try {
    mkdirSync(join(fixtureHome, '.codemoss'));
    mkdirSync(join(fixtureHome, '.codex'));
    writeFileSync(join(fixtureHome, '.codex', 'config.toml'), 'model_provider = "global_fixture"\n');
    writeFileSync(join(fixtureHome, '.codex', 'auth.json'), '{"OPENAI_API_KEY":"global-fixture"}');
    const providers = Object.fromEntries(['a', 'b'].map(id => [id, {
      configToml: `model_provider="${id}"\n[model_providers.${id}]\nname="${id}"\nbase_url="https://${id}.example.invalid/v1"\nwire_api="responses"\n[model_aliases]\nfixture-model="${id}-codex-model"\n`,
      authJson: JSON.stringify({ OPENAI_API_KEY: `fixture-${id}` }),
      settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: `fixture-${id}`, ANTHROPIC_BASE_URL: `https://${id}.example.invalid`,
        ANTHROPIC_DEFAULT_SONNET_MODEL: `${id}-model` } },
    }]));
    writeFileSync(join(fixtureHome, '.codemoss', 'config.json'), JSON.stringify({
      claude: { current: 'a', providers }, codex: { current: 'a', providers }, aiTitleGenerationEnabled: false,
    }));
    const result = await promisify(execFile)(process.execPath, [resolve('ai-bridge/config/testing/session-supplier-runtime.mjs')], {
      env: { ...process.env, HOME: fixtureHome, USERPROFILE: fixtureHome }, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.match(result.stdout, /SESSION_SUPPLIERS_OK/);
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true });
  }
});

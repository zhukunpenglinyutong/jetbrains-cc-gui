import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridgeDir = fileURLToPath(new URL('../../', import.meta.url));
const route = 'ccs-claude-provider-a--glm-pro';
const fixtures = [
  ['aggregate', {
    env: { ANTHROPIC_DEFAULT_SONNET_MODEL: `${route}[1m]`, ANTHROPIC_AUTH_TOKEN: 'fixture-secret' },
    modelPicker: { replaceBuiltInOptions: true, options: [
      { model: `${route}[1m]`, label: 'GLM Pro (Provider A)', description: 'glm-pro · 1M' },
      { model: 'ccs-claude-provider-b--glm-flash', label: 'GLM Flash (Provider B)' },
    ] },
  }],
  ['route', { env: {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'GLM Flash Route',
  } }],
  ['direct', { env: {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'GLM Flash Direct',
  } }],
];

for (const [mode, settings] of fixtures) {
  test(`channel-manager reads ${mode} settings through the real command`, () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-models-command-'));
    try {
      mkdirSync(join(homeDir, '.claude'));
      mkdirSync(join(homeDir, '.codemoss'));
      writeFileSync(join(homeDir, '.claude', 'settings.json'), JSON.stringify(settings));
      writeFileSync(join(homeDir, '.codemoss', 'config.json'), JSON.stringify({
        claude: { current: '__local_settings_json__', providers: {} },
      }));
      const output = execFileSync(process.execPath, ['channel-manager.js', 'claude', 'listModels'], {
        cwd: bridgeDir, encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_USE_STDIN: 'false' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const payload = JSON.parse(output.trim().split('\n').at(-1));
      assert.equal(payload.success, true);
      assert.equal(payload.provider, 'claude');
      assert.ok(!output.includes('fixture-secret'));
      if (mode === 'aggregate') {
        assert.equal(payload.replaceBuiltInOptions, true);
        assert.equal(payload.defaultModel, route);
        assert.deepEqual(payload.models, [
          { id: route, label: 'GLM Pro (Provider A)', description: 'glm-pro · 1M', supports1MContext: true },
          { id: 'ccs-claude-provider-b--glm-flash', label: 'GLM Flash (Provider B)', supports1MContext: false },
        ]);
      } else {
        assert.equal(payload.replaceBuiltInOptions, false);
        assert.deepEqual(payload.models, []);
        assert.equal(payload.modelMapping.sonnet, settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL);
        assert.equal(payload.modelMapping.sonnetName, settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME);
      }
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
}

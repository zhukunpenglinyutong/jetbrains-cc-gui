import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const API_CONFIG_MODULE = path.resolve('ai-bridge/config/api-config.js');

function runSetupApiKey(homeDir) {
  const script = `
    import { setupApiKey } from ${JSON.stringify(API_CONFIG_MODULE)};
    try {
      const result = setupApiKey();
      console.log(JSON.stringify({ ok: true, result }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error.message }));
    }
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        HOME: homeDir,
      },
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function runInjectNetworkEnv(homeDir) {
  const script = `
    import { injectNetworkEnvVars } from ${JSON.stringify(API_CONFIG_MODULE)};
    injectNetworkEnvVars();
    console.log(JSON.stringify({
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
    }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        HOME: homeDir,
      },
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function runResyncNetworkEnv(homeDir) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { injectNetworkEnvVars } from ${JSON.stringify(API_CONFIG_MODULE)};

    const home = process.env.HOME;
    const codemossDir = path.join(home, '.codemoss');
    const configPath = path.join(codemossDir, 'config.json');

    injectNetworkEnvVars();

    fs.writeFileSync(configPath, JSON.stringify({
      claude: {
        current: 'provider-a',
        providers: {
          'provider-a': {
            name: 'Provider A',
            settingsConfig: {}
          }
        }
      }
    }), 'utf8');

    injectNetworkEnvVars();

    console.log(JSON.stringify({
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
    }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        HOME: homeDir,
      },
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function writeCodemossClaudeConfig(homeDir, current, providers = {}) {
  const codemossDir = path.join(homeDir, '.codemoss');
  fs.mkdirSync(codemossDir, { recursive: true });
  fs.writeFileSync(
    path.join(codemossDir, 'config.json'),
    JSON.stringify({
      claude: {
        current,
        providers,
      },
    }),
    'utf8'
  );
}

test('setupApiKey does not fall back to Claude CLI credentials on disk', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: {} }), 'utf8');
  fs.writeFileSync(
    path.join(claudeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'should-not-be-used' } }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'API Key not configured');
});

test('setupApiKey accepts synced provider credentials when a managed provider is active', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, 'provider-a', {
    'provider-a': {
      name: 'Provider A',
      settingsConfig: {}
    }
  });

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-test-token',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'auth_token');
  assert.equal(result.result.baseUrl, 'https://api.anthropic.com');
});

test('setupApiKey does not read settings.json credentials when Claude provider is inactive', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-should-not-be-used',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'API Key not configured');
});

test('setupApiKey enters CLI login when config.json sets claude.current=__cli_login__', () => {
  // CLI login mode is identified by ~/.codemoss/config.json — NOT by any flag in
  // ~/.claude/settings.json. The plugin must never mutate the user's settings.json.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '__cli_login__');

  // settings.json has no CLI login flag — we are explicitly verifying it is not required
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: {} }), 'utf8');

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'cli_login');
  assert.equal(result.result.apiKey, null);
});

test('setupApiKey CLI login takes priority over existing API keys (no fallback)', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '__cli_login__');

  // Real-world scenario: user previously configured an API key under "use local
  // settings.json" mode, then switched to CLI login. The key remains in settings.json
  // (the plugin no longer deletes it), but CLI login mode MUST win — no silent fallback.
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-should-be-ignored',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'cli_login');
  assert.equal(result.result.apiKey, null);
  assert.equal(result.result.apiKeySource, 'CLI login (SDK native auth)');
});

test('setupApiKey honors legacy CCGUI_CLI_LOGIN_AUTHORIZED flag for backwards compatibility', () => {
  // Earlier plugin versions wrote CCGUI_CLI_LOGIN_AUTHORIZED=1 into settings.json.
  // Users upgrading from those versions may still have the flag — keep honoring it
  // as a fallback so they keep working until the residue is cleaned up.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  // config.json points at the legacy provider id, not __cli_login__
  writeCodemossClaudeConfig(tempHome, '__cli_login__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        CCGUI_CLI_LOGIN_AUTHORIZED: '1',
      },
    }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'cli_login');
  assert.equal(result.result.apiKey, null);
});

test('injectNetworkEnvVars ignores local proxy settings when Claude provider is inactive', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const result = runInjectNetworkEnv(tempHome);
  assert.equal(result.HTTP_PROXY, null);
  assert.equal(result.HTTPS_PROXY, null);
});

test('injectNetworkEnvVars ignores local proxy settings for managed providers', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, 'provider-a', {
    'provider-a': {
      name: 'Provider A',
      settingsConfig: {}
    }
  });

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const result = runInjectNetworkEnv(tempHome);
  assert.equal(result.HTTP_PROXY, null);
  assert.equal(result.HTTPS_PROXY, null);
});

test('injectNetworkEnvVars accepts proxy settings for the authorized local provider', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '__local_settings_json__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const result = runInjectNetworkEnv(tempHome);
  assert.equal(result.HTTP_PROXY, 'http://proxy.example.com:8080');
  assert.equal(result.HTTPS_PROXY, 'https://proxy.example.com:8443');
});

test('injectNetworkEnvVars clears previously injected proxy vars after switching away from local mode', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '__local_settings_json__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const result = runResyncNetworkEnv(tempHome);
  assert.equal(result.HTTP_PROXY, null);
  assert.equal(result.HTTPS_PROXY, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildCliEnv,
  buildWebviewControlledSettingsOverride,
  isDangerousEnvVar,
  isWebviewControlledEnvVar,
  WEBVIEW_CONTROLLED_ENV_VARS,
} from './api-config.js';
import { setModelEnvironmentVariables } from '../utils/model-utils.js';

const API_CONFIG_MODULE = pathToFileURL(path.resolve('ai-bridge/config/api-config.js')).href;
const MODEL_UTILS_MODULE = pathToFileURL(path.resolve('ai-bridge/utils/model-utils.js')).href;

// These tests must not depend on whatever the surrounding shell exports (relay users
// commonly export ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL globally). Clear the
// webview-controlled vars for the whole file; each test sets the ones it needs.
const FILE_SAVED_ENV = new Map(
  WEBVIEW_CONTROLLED_ENV_VARS.map((name) => [name, process.env[name]])
);
for (const name of WEBVIEW_CONTROLLED_ENV_VARS) {
  delete process.env[name];
}

test.after(() => {
  for (const [name, value] of FILE_SAVED_ENV) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

/**
 * Run `body` with the given routing values placed in process.env, restoring the previous
 * state of every webview-controlled var afterwards.
 *
 * @param {Object} values - env var name to value pairs to set for the duration of the body
 * @param {Function} body - test body to run
 */
function withProcessRoutingEnv(values, body) {
  const saved = new Map(WEBVIEW_CONTROLLED_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of WEBVIEW_CONTROLLED_ENV_VARS) {
    delete process.env[name];
  }
  Object.assign(process.env, values);
  try {
    body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test('Codex native access requires an active managed provider or explicitly authorized CLI Login', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-access-'));
  try {
    fs.mkdirSync(path.join(homeDir, '.codemoss'));
    for (const [codex, access] of [
      [{ current: '' }, 'inactive'],
      [{ current: '__codex_cli_login__' }, 'inactive'],
      [{ current: '__codex_cli_login__', localConfigAuthorized: true }, 'cli_login'],
      [{ current: 'provider', providers: { provider: { configToml: 'model="test"' } } }, 'managed'],
      [{ current: 'provider', providers: { provider: 'invalid' } }, 'inactive'],
    ]) {
      fs.writeFileSync(path.join(homeDir, '.codemoss', 'config.json'), JSON.stringify({ codex }));
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval',
        `import { getCodexRuntimeState } from ${JSON.stringify(API_CONFIG_MODULE)}; console.log(JSON.stringify(getCodexRuntimeState()));`],
      { env: buildChildEnv(homeDir), encoding: 'utf8' });
      assert.equal(JSON.parse(output.trim()).access, access);
    }
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
});

function buildChildEnv(homeDir) {
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
  };

  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_URL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ]) {
    delete env[key];
  }

  return env;
}

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
      env: buildChildEnv(homeDir),
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function runInjectStartupEnv(homeDir) {
  const script = `
    import { injectStartupEnvVars } from ${JSON.stringify(API_CONFIG_MODULE)};
    injectStartupEnvVars();
    console.log(JSON.stringify({
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      AWS_PROFILE: process.env.AWS_PROFILE ?? null,
      AWS_REGION: process.env.AWS_REGION ?? null,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: buildChildEnv(homeDir),
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function runResyncStartupEnv(homeDir) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { injectStartupEnvVars } from ${JSON.stringify(API_CONFIG_MODULE)};

    const home = process.env.HOME;
    const codemossDir = path.join(home, '.codemoss');
    const configPath = path.join(codemossDir, 'config.json');

    injectStartupEnvVars();

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

    injectStartupEnvVars();

    console.log(JSON.stringify({
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      AWS_PROFILE: process.env.AWS_PROFILE ?? null,
      AWS_REGION: process.env.AWS_REGION ?? null,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: buildChildEnv(homeDir),
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

function writeClaudeSettingsEnv(homeDir, env) {
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ env }),
    'utf8'
  );
}

/**
 * Build both routing layers the SDK receives in an isolated child process whose
 * HOME is {@code tempHome}: the CLI child env (options.env) and the inline
 * settings override (options.settings.env).
 *
 * The provider-management decision behind them reads ~/.codemoss/config.json and
 * ~/.claude/settings.json, so it has to run in a child with a temp HOME instead
 * of the developer's real files.
 *
 * @param {string} tempHome - isolated HOME for the child process
 * @param {string} modelId - model id the webview selected
 * @param {string} resolvedModelId - model the request resolved to
 * @returns {{childEnv: Object, settingsEnv: Object}} both layers, reduced to the routing vars
 */
function runRoutingLayers(tempHome, modelId = 'claude-sonnet-4-6', resolvedModelId = 'relay-sonnet-model') {
  const script = `
    import { buildCliEnv, buildWebviewControlledSettingsOverride } from ${JSON.stringify(API_CONFIG_MODULE)};
    import { setModelEnvironmentVariables } from ${JSON.stringify(MODEL_UTILS_MODULE)};
    setModelEnvironmentVariables(${JSON.stringify(resolvedModelId)}, ${JSON.stringify(modelId)});
    const childEnv = buildCliEnv();
    const override = buildWebviewControlledSettingsOverride(
      ${JSON.stringify(modelId)}, undefined, ${JSON.stringify(resolvedModelId)});
    console.log(JSON.stringify({
      childEnv: {
        HOST_MANAGED: childEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
        ANTHROPIC_MODEL: childEnv.ANTHROPIC_MODEL,
        SONNET: childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL,
      },
      settingsEnv: {
        ANTHROPIC_MODEL: override.env.ANTHROPIC_MODEL,
        SONNET: override.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      },
    }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: buildChildEnv(tempHome),
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

// Run buildCliEnv() in an isolated child process whose HOME points at tempHome,
// so the provider-management decision is driven solely by the temp settings.json
// — never by the developer's real ~/.claude/settings.json.
function runBuildCliEnv(tempHome) {
  const script = `
    import { buildCliEnv } from ${JSON.stringify(API_CONFIG_MODULE)};
    const env = buildCliEnv();
    console.log(JSON.stringify({
      ENTRYPOINT: env.CLAUDE_CODE_ENTRYPOINT,
      USER_TYPE: env.USER_TYPE,
      HOST_MANAGED: env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
      EFFORT: env.CLAUDE_CODE_EFFORT_LEVEL,
      MAX_THINKING: env.MAX_THINKING_TOKENS,
      DISABLE_1M: env.CLAUDE_CODE_DISABLE_1M_CONTEXT,
      SDK_VERSION: env.CLAUDE_AGENT_SDK_VERSION,
    }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: {
        ...buildChildEnv(tempHome),
        // Verify the "drop inherited copy" path: the daemon may itself carry
        // the flag from a parent host. buildCliEnv must clear it for cloud
        // providers even when it is already in process.env.
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
        CLAUDE_CODE_EFFORT_LEVEL: 'max',
        MAX_THINKING_TOKENS: '64000',
        CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
        CLAUDE_AGENT_SDK_VERSION: 'should-not-leak',
        ANTHROPIC_MODEL: 'current-webview-model',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'current-webview-model',
        HTTPS_PROXY: 'http://proxy.example.com:8080',
      },
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

test('isWebviewControlledEnvVar classifies model, context, and reasoning controls correctly', () => {
  assert.equal(isWebviewControlledEnvVar('ANTHROPIC_MODEL'), true);
  assert.equal(isWebviewControlledEnvVar('ANTHROPIC_DEFAULT_FABLE_MODEL'), true);
  assert.equal(isWebviewControlledEnvVar('anthropic_model'), true); // case-insensitive
  assert.equal(isWebviewControlledEnvVar('CLAUDE_CODE_EFFORT_LEVEL'), true);
  assert.equal(isWebviewControlledEnvVar('MAX_THINKING_TOKENS'), true);
  assert.equal(isWebviewControlledEnvVar('CLAUDE_CODE_DISABLE_1M_CONTEXT'), true);
  assert.equal(isWebviewControlledEnvVar('HTTPS_PROXY'), false);
  assert.equal(isWebviewControlledEnvVar('ANTHROPIC_API_KEY'), false);
});

test('isDangerousEnvVar blocks code injection and Codex CLI path overrides', () => {
  assert.equal(isDangerousEnvVar('NODE_OPTIONS'), true);
  assert.equal(isDangerousEnvVar('LD_PRELOAD'), true);
  // A request-injected CLI path override would relaunch the app-server child
  // as an attacker binary with managed credentials.
  assert.equal(isDangerousEnvVar('CODEX_BIN'), true);
  assert.equal(isDangerousEnvVar('CODEX_PATH'), true);
  assert.equal(isDangerousEnvVar('CODEX_CLI_PATH'), true);
  assert.equal(isDangerousEnvVar('codex_cli_path'), true); // case-insensitive
  assert.equal(isDangerousEnvVar('ANTHROPIC_API_KEY'), false);
  assert.equal(isDangerousEnvVar('PATH'), false); // Java EnvironmentConfigurator supplies PATH
});

test('buildCliEnv strips stale CLI override env vars and sets host-managed for first-party auth', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  // Active managed provider so loadClaudeSettings() returns settings; no cloud
  // flag set → host-managed should be '1'.
  writeCodemossClaudeConfig(tempHome, 'provider-a', {
    'provider-a': { name: 'Provider A', settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: 'sk-test' } } },
  });
  writeClaudeSettingsEnv(tempHome, { ANTHROPIC_AUTH_TOKEN: 'sk-test' });

  const env = runBuildCliEnv(tempHome);

  // Reasoning/context controls stripped from the child env
  assert.equal(env.EFFORT, undefined);
  assert.equal(env.MAX_THINKING, undefined);
  assert.equal(env.DISABLE_1M, undefined);
  assert.equal(env.SDK_VERSION, undefined);
  // Identity + host-managed flag set for first-party auth
  assert.equal(env.ENTRYPOINT, 'cli');
  assert.equal(env.USER_TYPE, 'external');
  assert.equal(env.HOST_MANAGED, '1');
});

test('buildWebviewControlledSettingsOverride neutralizes Claude CLI settings env precedence', () => {
  // Without settings tiers or a resolved model (the one-shot callers), every model routing
  // var is blank, so neither a settings.json copy nor an inherited process.env value can
  // take effect on the non-managed path.
  const modelRoutingOverrides = {
    ANTHROPIC_MODEL: '',
    ANTHROPIC_DEFAULT_FABLE_MODEL: '',
    ANTHROPIC_DEFAULT_OPUS_MODEL: '',
    ANTHROPIC_DEFAULT_SONNET_MODEL: '',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
    ANTHROPIC_SMALL_FAST_MODEL: '',
    CLAUDE_CODE_SUBAGENT_MODEL: '',
  };

  assert.deepEqual(buildWebviewControlledSettingsOverride('claude-sonnet-4-6[1m]'), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
      ...modelRoutingOverrides,
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '',
    },
  });

  assert.deepEqual(buildWebviewControlledSettingsOverride('claude-sonnet-4-6'), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
      ...modelRoutingOverrides,
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    },
  });

  assert.deepEqual(buildWebviewControlledSettingsOverride(), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
      ...modelRoutingOverrides,
    },
  });
});

test('buildWebviewControlledSettingsOverride forwards configured tiers instead of blanking them', () => {
  // This test only pins the shape of the function's output when no request-resolved model is
  // passed: configured tiers are echoed back verbatim, unconfigured ones stay blank.
  //
  // Without CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST (CLI login, cloud providers) the CLI honors
  // this layer on top of the child env, so configured tiers must not be blanked here.
  const settingsEnv = {
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3-flash',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'doubao-seed-2.1-lite',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'DeepSeek-V4.1-Flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'DeepSeek-V4.1-Flash',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-v3.2',
    ANTHROPIC_MODEL: 'stale-global-model',
  };

  assert.deepEqual(buildWebviewControlledSettingsOverride('claude-sonnet-4-6', settingsEnv), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
      ANTHROPIC_MODEL: '',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'DeepSeek-V4.1-Flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'DeepSeek-V4.1-Flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'doubao-seed-2.1-lite',
      ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-v3.2',
      CLAUDE_CODE_SUBAGENT_MODEL: '',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    },
  });
});

test('buildWebviewControlledSettingsOverride leaves unconfigured tiers blank', () => {
  const result = buildWebviewControlledSettingsOverride('claude-opus-5', {
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3-flash',
  });

  assert.equal(result.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.3-flash');
  assert.equal(result.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, '');
  assert.equal(result.env.CLAUDE_CODE_SUBAGENT_MODEL, '');
  assert.equal(
    result.env.ANTHROPIC_MODEL,
    '',
    'ANTHROPIC_MODEL must stay blank: blocking the stale settings.json copy is exactly the issue #1509 fix'
  );
});

test('buildWebviewControlledSettingsOverride mirrors the request-resolved model over settings.json', () => {
  // The resolved model wins over the settings.json mapping for ANTHROPIC_MODEL and for the
  // tier the request owns. Tiers the request did not touch keep echoing settings.json.
  const result = buildWebviewControlledSettingsOverride('claude-sonnet-4-6', {
    ANTHROPIC_MODEL: 'stale-global-model',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'stale-sonnet-model',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3-flash',
  }, 'relay-sonnet-model');

  assert.equal(result.env.ANTHROPIC_MODEL, 'relay-sonnet-model',
    'the request-resolved model must win over the settings.json copy');
  assert.equal(result.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'relay-sonnet-model',
    'the tier owned by the current request must mirror the request-resolved value');
  assert.equal(result.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.3-flash',
    'tiers the request did not touch keep echoing settings.json');
  assert.equal(result.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, '');
  assert.equal(result.env.CLAUDE_CODE_SUBAGENT_MODEL, '');

  // Without a resolved model the stale settings.json copy must stay blocked (#1509).
  const fallback = buildWebviewControlledSettingsOverride('claude-sonnet-4-6', {
    ANTHROPIC_MODEL: 'stale-global-model',
  });
  assert.equal(fallback.env.ANTHROPIC_MODEL, '');
  assert.equal(fallback.env.ANTHROPIC_DEFAULT_SONNET_MODEL, '');
});

test('buildWebviewControlledSettingsOverride routes the resolved model to the tier of the selected family', () => {
  const cases = [
    ['claude-fable-5-1', 'ANTHROPIC_DEFAULT_FABLE_MODEL'],
    ['claude-opus-4-7', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
    ['claude-haiku-4-5', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
    ['claude-sonnet-4-6', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
    ['qwen3.5-plus', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
  ];
  for (const [modelId, ownedKey] of cases) {
    const result = buildWebviewControlledSettingsOverride(modelId, {}, 'mapped-model');
    for (const key of ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
      assert.equal(result.env[key], key === ownedKey ? 'mapped-model' : '', `${modelId} -> ${key}`);
    }
  }
});

test('buildWebviewControlledSettingsOverride keeps the [1m] state of the request on its tier', () => {
  const enabled = buildWebviewControlledSettingsOverride('claude-sonnet-4-6[1m]', {}, 'claude-sonnet-4-6[1m]');
  assert.equal(enabled.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-6[1m]',
    'a blank or settings.json entry would drop the suffix the CLI must see');
  assert.equal(enabled.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, '');

  // The request turned 1M off: a [1m] copy in settings.json must not come back on this tier.
  const disabled = buildWebviewControlledSettingsOverride('claude-sonnet-4-6', {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6[1m]',
  }, 'claude-sonnet-4-6');
  assert.equal(disabled.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-6');
  assert.equal(disabled.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, '1');
});

test('buildWebviewControlledSettingsOverride never mirrors routing values left in process.env', () => {
  // Values inherited from the IDE environment (e.g. a relay tutorial's global exports) or left
  // by an earlier turn are not this request's routing. setModelEnvironmentVariables() only
  // clears them when settings.json has an env block, and the one-shot callers never call it,
  // so the override must not read process.env: on the non-managed path a mirrored value would
  // win over the CLI defaults (e.g. the haiku tier used by the Explore subagent).
  withProcessRoutingEnv({
    ANTHROPIC_MODEL: 'ambient-model',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'ambient-relay-opus',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'ambient-relay-sonnet',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'ambient-relay-haiku',
    CLAUDE_CODE_SUBAGENT_MODEL: 'ambient-subagent',
  }, () => {
    const daemon = buildWebviewControlledSettingsOverride('claude-sonnet-4-6', undefined, 'claude-sonnet-4-6');
    assert.equal(daemon.env.ANTHROPIC_MODEL, 'claude-sonnet-4-6');
    assert.equal(daemon.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-6');
    assert.equal(daemon.env.ANTHROPIC_DEFAULT_OPUS_MODEL, '');
    assert.equal(daemon.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, '');
    assert.equal(daemon.env.CLAUDE_CODE_SUBAGENT_MODEL, '');

    // One-shot callers (commit message, prompt enhancer, rewind) pass no resolved model.
    const oneShot = buildWebviewControlledSettingsOverride('claude-haiku-4-5');
    assert.equal(oneShot.env.ANTHROPIC_MODEL, '');
    assert.equal(oneShot.env.ANTHROPIC_DEFAULT_SONNET_MODEL, '');
    assert.equal(oneShot.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, '');
  });
});

test('buildWebviewControlledSettingsOverride agrees with the snapshot setModelEnvironmentVariables writes', () => {
  // On the daemon path both layers are built from the same request, so the honored layer
  // (settings override, non-managed) and the child env (managed) must carry the same routing.
  const settingsEnv = {
    ANTHROPIC_MODEL: 'stale-global-model',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6[1m]',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-v3.2',
  };
  const requests = [
    ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['claude-sonnet-4-6[1m]', 'claude-sonnet-4-6[1m]'],
    ['claude-opus-4-7', 'glm-5.3-flash'],
    ['claude-haiku-4-5', 'stale-global-model'],
    ['claude-fable-5-1', 'stale-global-model'],
    ['qwen3.5-plus', 'qwen3.5-plus'],
    ['ccs-claude-opus-relay', 'ccs-claude-opus-relay'],
  ];
  for (const [modelId, resolvedModelId] of requests) {
    withProcessRoutingEnv({}, () => {
      setModelEnvironmentVariables(resolvedModelId, modelId, settingsEnv);
      const override = buildWebviewControlledSettingsOverride(modelId, settingsEnv, resolvedModelId);
      for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
        'CLAUDE_CODE_SUBAGENT_MODEL']) {
        assert.equal(override.env[key], process.env[key] ?? '', `${modelId}: ${key}`);
      }
    });
  }
});

test('buildCliEnv leaves CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST unset for cloud providers', () => {
  // Bedrock/Vertex/Foundry: the user's settings.json owns the provider switch.
  // The host-managed flag would make Claude Code strip it → 403, so it must be
  // absent — even when process.env already carries an inherited copy.
  for (const flag of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
    writeCodemossClaudeConfig(tempHome, 'provider-a', {
      'provider-a': { name: 'Provider A', settingsConfig: { env: { [flag]: '1' } } },
    });
    writeClaudeSettingsEnv(tempHome, { [flag]: '1' });

    const env = runBuildCliEnv(tempHome);

    assert.equal(env.HOST_MANAGED, undefined,
      `${flag} should suppress the host-managed flag (and clear any inherited copy)`);
    // Identity env must still be present regardless of provider mode.
    assert.equal(env.ENTRYPOINT, 'cli');
    assert.equal(env.USER_TYPE, 'external');
  }
});

test('buildCliEnv leaves CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST unset for CLI login', () => {
  // Regression guard for #1327: CLI login relies on the Claude CLI's own OAuth
  // credentials. The host-managed flag makes the CLI strip its native credential
  // lookup, so an authenticated user gets "Not logged in · Please run /login".
  // cli_login is signaled purely by ~/.codemoss/config.json (claude.current), so
  // no cloud-provider flag is present — the pre-fix code wrongly defaulted to
  // host-managed here. The flag must be absent, even when process.env carries an
  // inherited copy from a parent Claude Code host.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  writeCodemossClaudeConfig(tempHome, '__cli_login__');
  writeClaudeSettingsEnv(tempHome, {});

  const env = runBuildCliEnv(tempHome);

  assert.equal(env.HOST_MANAGED, undefined,
    'CLI login must suppress the host-managed flag (and clear any inherited copy)');
  // Identity env must still be present regardless of provider mode.
  assert.equal(env.ENTRYPOINT, 'cli');
  assert.equal(env.USER_TYPE, 'external');
});

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

test('injectStartupEnvVars ignores local proxy settings when Claude provider is inactive', () => {
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

  const result = runInjectStartupEnv(tempHome);
  assert.equal(result.HTTP_PROXY, null);
  assert.equal(result.HTTPS_PROXY, null);
});

test('injectStartupEnvVars ignores local proxy settings for managed providers', () => {
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

  const result = runInjectStartupEnv(tempHome);
  assert.equal(result.HTTP_PROXY, null);
  assert.equal(result.HTTPS_PROXY, null);
});

test('injectStartupEnvVars accepts proxy settings for the authorized local provider', () => {
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

  const result = runInjectStartupEnv(tempHome);
  assert.equal(result.HTTP_PROXY, 'http://proxy.example.com:8080');
  assert.equal(result.HTTPS_PROXY, 'https://proxy.example.com:8443');
});

test('injectStartupEnvVars clears previously injected proxy vars after switching away from local mode', () => {
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

  const result = runResyncStartupEnv(tempHome);
  assert.equal(result.HTTP_PROXY, null);
  assert.equal(result.HTTPS_PROXY, null);
});

test('injectStartupEnvVars injects AWS credential vars for the authorized local provider', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '__local_settings_json__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        AWS_PROFILE: 'bedrock-profile',
        AWS_REGION: 'us-west-2',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      },
    }),
    'utf8'
  );

  const result = runInjectStartupEnv(tempHome);
  assert.equal(result.AWS_PROFILE, 'bedrock-profile');
  assert.equal(result.AWS_REGION, 'us-west-2');
  assert.equal(result.AWS_SECRET_ACCESS_KEY, 'test-secret-key');
});

test('injectStartupEnvVars clears previously injected AWS credential vars after switching away from local mode', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '__local_settings_json__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        AWS_PROFILE: 'bedrock-profile',
        AWS_REGION: 'us-west-2',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      },
    }),
    'utf8'
  );

  const result = runResyncStartupEnv(tempHome);
  assert.equal(result.AWS_PROFILE, null);
  assert.equal(result.AWS_REGION, null);
  assert.equal(result.AWS_SECRET_ACCESS_KEY, null);
});

test('provider-management contract: both routing layers carry the request in each mode', () => {
  // The managed flag decides WHICH layer the CLI honors, so the contract pins both layers in
  // both modes (options.env and options.settings.env). Which layer actually wins is CLI
  // behavior and cannot be observed here; what this test guarantees is that whichever one
  // the CLI honors carries the request.
  //
  // Managed (plugin-owned provider, i.e. relay users): the CLI strips provider/model routing
  // vars from settings sources, so the child env decides.
  const managedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-routing-managed-'));
  try {
    writeCodemossClaudeConfig(managedHome, 'provider-a', {
      'provider-a': { name: 'Provider A', settingsConfig: { env: {} } },
    });
    writeClaudeSettingsEnv(managedHome, {});

    const managed = runRoutingLayers(managedHome);
    assert.equal(managed.childEnv.HOST_MANAGED, '1',
      'a plugin-owned provider must advertise provider management');
    assert.equal(managed.childEnv.ANTHROPIC_MODEL, 'relay-sonnet-model',
      'the honored layer in managed mode must carry the request');
    assert.equal(managed.childEnv.SONNET, 'relay-sonnet-model');
    assert.equal(managed.settingsEnv.ANTHROPIC_MODEL, 'relay-sonnet-model');
    assert.equal(managed.settingsEnv.SONNET, 'relay-sonnet-model');

    // The [1m] suffix must survive into both layers: on the non-managed path a blank
    // settings entry used to shadow it.
    const suffix = runRoutingLayers(managedHome, 'claude-sonnet-4-6[1m]', 'claude-sonnet-4-6[1m]');
    assert.equal(suffix.childEnv.SONNET, 'claude-sonnet-4-6[1m]');
    assert.equal(suffix.settingsEnv.SONNET, 'claude-sonnet-4-6[1m]',
      'the tier resolved for the request must keep its [1m] suffix');
    assert.equal(suffix.settingsEnv.ANTHROPIC_MODEL, 'claude-sonnet-4-6[1m]');
  } finally {
    fs.rmSync(managedHome, { recursive: true, force: true });
  }

  // CLI login: no managed flag, so the inline settings layer IS honored and has to carry
  // the request values (this is the path the mirroring protects).
  const loginHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-routing-login-'));
  try {
    writeCodemossClaudeConfig(loginHome, '__cli_login__');

    const login = runRoutingLayers(loginHome);
    assert.equal(login.childEnv.HOST_MANAGED, undefined,
      'CLI login must not advertise provider management');
    assert.equal(login.childEnv.ANTHROPIC_MODEL, 'relay-sonnet-model');
    assert.equal(login.childEnv.SONNET, 'relay-sonnet-model');
    assert.equal(login.settingsEnv.ANTHROPIC_MODEL, 'relay-sonnet-model',
      'without the managed flag the honored layer must agree with the request');
    assert.equal(login.settingsEnv.SONNET, 'relay-sonnet-model');
  } finally {
    fs.rmSync(loginHome, { recursive: true, force: true });
  }
});

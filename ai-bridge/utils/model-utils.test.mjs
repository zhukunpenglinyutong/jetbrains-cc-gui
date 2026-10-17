import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapModelIdToSdkName,
  readConfiguredModelTiers,
  resolveModelFromSettings,
  resolveSdkModelName,
  setModelEnvironmentVariables,
} from './model-utils.js';

// --- resolveSdkModelName --------------------------------------------------

test('route and direct requests use model ids, never their display names', () => {
  for (const id of ['claude-sonnet-5[1M]', 'glm-flash[1M]']) {
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: id, ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Display name only' };
    const resolved = resolveModelFromSettings('claude-sonnet-5[1m]', env);
    assert.equal(resolved, id.replace(/\[1m\]$/i, '[1m]'));
    assert.equal(resolveSdkModelName('claude-sonnet-5[1m]', resolved), resolved);
    assert.notEqual(resolved, env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME);
  }
});

test('cc-switch routes bypass family mappings and reach the SDK verbatim', () => {
  const env = {
    ANTHROPIC_MODEL: 'ccs-claude-default--glm-5.3',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'ccs-claude-default--glm-5.3',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'ccs-claude-default--glm-5.3',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'ccs-claude-default--glm-5.3',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'ccs-claude-default--glm-5.3',
  };
  for (const id of ['ccs-claude-a--claude-sonnet-5', 'ccs-claude-b--claude-opus-5[1m]', 'ccs-claude-haiku--glm-5.3', 'ccs-claude-fable--grok-4.7']) {
    const resolved = resolveModelFromSettings(id, env);
    assert.equal(resolved, id);
    assert.equal(resolveSdkModelName(id, resolved), id);
  }
});

test('resolveSdkModelName hands the exact resolved id to the SDK, alias only as fallback', () => {
  // A specific Opus generation must not collapse to the 'opus' alias: the
  // settings override blanks ANTHROPIC_DEFAULT_OPUS_MODEL, so the alias would
  // resolve to the CLI default (opus-5) instead of the requested model.
  assert.equal(resolveSdkModelName('claude-opus-4-6[1m]', 'claude-opus-4-6[1m]'), 'claude-opus-4-6[1m]');
  assert.equal(resolveSdkModelName('claude-opus-4-6', 'claude-opus-4-6'), 'claude-opus-4-6');
  // Provider mappings (settings.json env) are passed through verbatim.
  assert.equal(resolveSdkModelName('claude-sonnet-5', 'MiniMax-M2.5'), 'MiniMax-M2.5');
  assert.equal(resolveSdkModelName('claude-sonnet-5', '  custom  '), 'custom');
  // No resolved id -> family alias, matching the previous behavior.
  assert.equal(resolveSdkModelName('claude-opus-5', ''), 'opus');
  assert.equal(resolveSdkModelName('claude-opus-5', null), 'opus');
  assert.equal(resolveSdkModelName(null, undefined), 'sonnet');
});

// --- mapModelIdToSdkName ------------------------------------------------

test('mapModelIdToSdkName maps Claude families to short SDK names', () => {
  assert.equal(mapModelIdToSdkName('claude-fable-5'), 'fable');
  assert.equal(mapModelIdToSdkName('claude-opus-5'), 'opus');
  assert.equal(mapModelIdToSdkName('claude-opus-4-8'), 'opus');
  assert.equal(mapModelIdToSdkName('claude-haiku-4-5'), 'haiku');
  assert.equal(mapModelIdToSdkName('claude-sonnet-4-7'), 'sonnet');
  assert.equal(mapModelIdToSdkName('claude-sonnet-4-6'), 'sonnet');
  // Unknown / third-party IDs fall back to sonnet (because the SDK uses
  // ANTHROPIC_DEFAULT_SONNET_MODEL as the lookup target for arbitrary names).
  assert.equal(mapModelIdToSdkName('mimo-v2.5-pro'), 'sonnet');
  assert.equal(mapModelIdToSdkName(''), 'sonnet');
  assert.equal(mapModelIdToSdkName(null), 'sonnet');
});

// --- resolveModelFromSettings -------------------------------------------

test('resolveModelFromSettings returns original when no settings env provided', () => {
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', null), 'claude-sonnet-4-6');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', {}), 'claude-sonnet-4-6');
});

test('resolveModelFromSettings applies model-specific settings mapping', () => {
  const env = {
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.2-fable',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7-opus',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7-flash',
  };
  assert.equal(resolveModelFromSettings('claude-fable-5', env), 'glm-5.2-fable');
  assert.equal(resolveModelFromSettings('claude-opus-5', env), 'glm-4.7-opus');
  assert.equal(resolveModelFromSettings('claude-opus-4-8', env), 'glm-4.7-opus');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-7', env), 'glm-4.7');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'glm-4.7');
  assert.equal(resolveModelFromSettings('claude-haiku-4-5', env), 'glm-4.7-flash');
});

test('resolveModelFromSettings uses ANTHROPIC_MODEL as fallback when family mapping is absent', () => {
  const env = {
    ANTHROPIC_MODEL: 'override-everywhere',
  };
  assert.equal(resolveModelFromSettings('claude-fable-5', env), 'override-everywhere');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'override-everywhere');
  assert.equal(resolveModelFromSettings('claude-opus-4-8', env), 'override-everywhere');
});

test('resolveModelFromSettings prefers family mapping over stale ANTHROPIC_MODEL', () => {
  const env = {
    ANTHROPIC_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
  };
  assert.equal(resolveModelFromSettings('claude-fable-5', env), 'deepseek-v4-pro');
  assert.equal(resolveModelFromSettings('claude-haiku-4-5', env), 'deepseek-v4-flash');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'deepseek-v4-flash');
});

test('resolveModelFromSettings ignores empty / whitespace mapping values', () => {
  const env = {
    ANTHROPIC_DEFAULT_FABLE_MODEL: '   ',
    ANTHROPIC_DEFAULT_SONNET_MODEL: '   ',
    ANTHROPIC_DEFAULT_OPUS_MODEL: '',
  };
  assert.equal(resolveModelFromSettings('claude-fable-5', env), 'claude-fable-5');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'claude-sonnet-4-6');
  assert.equal(resolveModelFromSettings('claude-opus-4-8', env), 'claude-opus-4-8');
});

test('resolveModelFromSettings does NOT remap non-Anthropic model IDs', () => {
  // A third-party model name like 'qwen3-max' should pass through unchanged
  // even when ANTHROPIC_DEFAULT_SONNET_MODEL is configured. Otherwise we would
  // silently rewrite intentional model selections.
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7' };
  assert.equal(resolveModelFromSettings('qwen3-max', env), 'qwen3-max');
  assert.equal(resolveModelFromSettings('deepseek-v4-pro', env), 'deepseek-v4-pro');
});

// --- [1m] suffix follows the webview request state ------------------------
//
// Bug: when a user opens the 1M context toggle in the UI, the frontend sends
//   `claude-sonnet-4-6[1m]` to the backend. If `settings.json` contains a
//   provider mapping like `ANTHROPIC_DEFAULT_SONNET_MODEL=glm-4.7` (no [1m]),
//   the old resolver returned `'glm-4.7'`, silently dropping the suffix.
//   The Claude SDK then read the env var without [1m] and did NOT enable the
//   1M context window even though the toggle was on.
// Fix: make the request modelId the source of truth. Preserve/append [1m] when
// the toggle is on, and strip stale mapping suffixes when the toggle is off.

test('resolveModelFromSettings preserves [1m] suffix when mapping value lacks it', () => {
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7' };
  assert.equal(
    resolveModelFromSettings('claude-sonnet-4-6[1m]', env),
    'glm-4.7[1m]',
    'request asked for 1M, mapping must keep the [1m] suffix so the SDK enables 1M context'
  );
});

test('resolveModelFromSettings does not double-append [1m] when mapping already has it', () => {
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]' };
  assert.equal(
    resolveModelFromSettings('claude-sonnet-4-6[1m]', env),
    'deepseek-v4-pro[1m]'
  );
});

test('resolveModelFromSettings strips stale [1m] suffix when 1M toggle is OFF', () => {
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7[1M]' };
  assert.equal(
    resolveModelFromSettings('claude-sonnet-4-6', env),
    'glm-4.7',
    'request did not ask for 1M, stale settings mapping suffix must not force it on'
  );
});

test('resolveModelFromSettings preserves [1m] across ANTHROPIC_MODEL global override', () => {
  const env = { ANTHROPIC_MODEL: 'override-model[1M]' };
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6[1m]', env), 'override-model[1m]');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'override-model');
});

test('resolveModelFromSettings preserves [1m] for opus mapping', () => {
  const env = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro' };
  assert.equal(resolveModelFromSettings('claude-opus-4-8[1m]', env), 'mimo-v2.5-pro[1m]');
});

// --- setModelEnvironmentVariables ---------------------------------------

test('setModelEnvironmentVariables sets fable env for fable-family base model', () => {
  const previous = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_FABLE_MODEL: process.env.ANTHROPIC_DEFAULT_FABLE_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  };
  try {
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;

    setModelEnvironmentVariables('glm-5.2-fable[1m]', 'claude-fable-5[1m]');

    assert.equal(process.env.ANTHROPIC_MODEL, 'glm-5.2-fable[1m]');
    assert.equal(process.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'glm-5.2-fable[1m]');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('setModelEnvironmentVariables sets sonnet env for sonnet-family base model', () => {
  const previous = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  };
  try {
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;

    setModelEnvironmentVariables('glm-4.7[1m]', 'claude-sonnet-4-6[1m]');

    assert.equal(process.env.ANTHROPIC_MODEL, 'glm-4.7[1m]');
    assert.equal(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-4.7[1m]');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// --- readConfiguredModelTiers -------------------------------------------

test('readConfiguredModelTiers returns only the tiers the user configured', () => {
  assert.deepEqual(readConfiguredModelTiers(null), {});
  assert.deepEqual(readConfiguredModelTiers(undefined), {});
  assert.deepEqual(readConfiguredModelTiers('not-an-object'), {});
  assert.deepEqual(
    readConfiguredModelTiers({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'doubao-seed-2.1-lite',
      ANTHROPIC_DEFAULT_SONNET_MODEL: '   ',
      ANTHROPIC_MODEL: 'deepseek-v4.1-flash',
      UNRELATED_KEY: 'x',
    }),
    {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'doubao-seed-2.1-lite',
    },
    'blank values are dropped so callers never blank a tier the user did not configure; ANTHROPIC_MODEL is not a tier'
  );
});

// --- subagent tier sync --------------------------------------------------
//
// Defect: only the tier the current request belongs to was written to process.env. A subagent
// declaring `model: opus` could not find ANTHROPIC_DEFAULT_OPUS_MODEL and fell back to the
// CLI's built-in Anthropic model name; third-party endpoints do not recognize that name and
// silently route to some default model. The sonnet tier looked "fine" only by coincidence:
// the fallback branch always writes ANTHROPIC_DEFAULT_SONNET_MODEL.

test('setModelEnvironmentVariables backfills every configured tier from settings.json', () => {
  const tracked = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
  ];
  const previous = Object.fromEntries(tracked.map((key) => [key, process.env[key]]));
  try {
    for (const key of tracked) delete process.env[key];

    setModelEnvironmentVariables('DeepSeek-V4.1-Flash', 'deepseek-v4.1-flash', {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'doubao-seed-2.1-lite',
      ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-v3.2',
      ANTHROPIC_MODEL: 'stale-value-must-be-ignored',
    });

    // The current request owns ANTHROPIC_MODEL and the tier it belongs to.
    assert.equal(process.env.ANTHROPIC_MODEL, 'DeepSeek-V4.1-Flash');
    assert.equal(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'DeepSeek-V4.1-Flash');
    // Every other configured tier survives, so subagents can resolve their own tiers.
    assert.equal(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.3-flash');
    assert.equal(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'doubao-seed-2.1-lite');
    assert.equal(process.env.ANTHROPIC_SMALL_FAST_MODEL, 'deepseek-v3.2');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('setModelEnvironmentVariables keeps the request model for the tier it owns', () => {
  const tracked = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'];
  const previous = Object.fromEntries(tracked.map((key) => [key, process.env[key]]));
  try {
    for (const key of tracked) delete process.env[key];

    // The request picks the opus tier and its mapping differs from settings.json:
    // the request value must win for that tier.
    setModelEnvironmentVariables('mimo-v2.5-pro', 'claude-opus-4-8', {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'stale-opus-mapping',
    });

    assert.equal(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'mimo-v2.5-pro');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('setModelEnvironmentVariables without settingsEnv leaves other tiers untouched', () => {
  const tracked = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'];
  const previous = Object.fromEntries(tracked.map((key) => [key, process.env[key]]));
  try {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'preserved';
    delete process.env.ANTHROPIC_MODEL;

    setModelEnvironmentVariables('glm-4.7', 'claude-sonnet-4-6');

    assert.equal(
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      'preserved',
      'without settingsEnv, tiers published by other paths must not be cleared'
    );
    assert.equal(process.env.ANTHROPIC_MODEL, 'glm-4.7');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('setModelEnvironmentVariables clears tiers the settings no longer configure', () => {
  const tracked = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'];
  const previous = Object.fromEntries(tracked.map((key) => [key, process.env[key]]));
  try {
    // A previous Claude provider left its opus tier behind in the long-lived daemon.
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'stale-opus-from-previous-provider';
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;

    // The provider now in use configures the sonnet tier only.
    setModelEnvironmentVariables('DeepSeek-V4.1-Flash', 'deepseek-v4.1-flash', {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'DeepSeek-V4.1-Flash',
    });

    assert.equal(
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      undefined,
      'a tier the current settings no longer configure must be cleared, otherwise subagents resolve to the previous provider model name'
    );
    assert.equal(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'DeepSeek-V4.1-Flash');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('setModelEnvironmentVariables routes haiku base to haiku env', () => {
  const previous = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  };
  try {
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;

    setModelEnvironmentVariables('glm-4.7-flash', 'claude-haiku-4-5');

    assert.equal(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-4.7-flash');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

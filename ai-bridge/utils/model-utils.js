/**
 * Model utilities module.
 * Handles model ID mapping and environment variable configuration.
 */

/**
 * Map a full model ID to the short name expected by the Claude SDK.
 * @param {string} modelId - Full model ID (e.g. 'claude-sonnet-4-5')
 * @returns {string} SDK model name (e.g. 'sonnet')
 */
export function mapModelIdToSdkName(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    return 'sonnet'; // Default to sonnet
  }

  const lowerModel = modelId.toLowerCase();

  // Mapping rules:
  // - Contains 'fable' -> 'fable'
  // - Contains 'opus' -> 'opus'
  // - Contains 'haiku' -> 'haiku'
  // - Otherwise (contains 'sonnet' or unknown) -> 'sonnet'
  if (lowerModel.includes('fable')) {
    return 'fable';
  } else if (lowerModel.includes('opus')) {
    return 'opus';
  } else if (lowerModel.includes('haiku')) {
    return 'haiku';
  } else {
    return 'sonnet';
  }
}

/**
 * Pick the `model` value handed to the Claude SDK for a request.
 *
 * Prefer the exact resolved id (e.g. 'claude-opus-4-6[1m]' or a provider
 * mapping like 'MiniMax-M2.5') over the family alias from mapModelIdToSdkName.
 * The alias ('opus') only works if the CLI can read ANTHROPIC_DEFAULT_OPUS_MODEL,
 * but buildWebviewControlledSettingsOverride blanks that variable so stale
 * settings.json values cannot leak in - which also blanks the per-request value
 * and makes 'opus' silently resolve to the CLI's default Opus. Passing the
 * exact id sidesteps env precedence entirely.
 *
 * @param {string|null} modelId - Original model ID from the webview
 * @param {string|null} resolvedModelId - Output of resolveModelFromSettings
 * @returns {string} Value for the SDK `model` option
 */
export function resolveSdkModelName(modelId, resolvedModelId) {
  const exact = typeof resolvedModelId === 'string' ? resolvedModelId.trim() : '';
  return exact || mapModelIdToSdkName(modelId);
}

/**
 * Resolve the actual model name for API calls from user's settings.json.
 * When the user configures a model mapping in their provider config (e.g. sonnet -> "MiniMax-M2.5"),
 * those values are written to ~/.claude/settings.json as ANTHROPIC_DEFAULT_*_MODEL env vars.
 * This function checks those settings and returns the mapped model name if configured.
 *
 * Priority: ANTHROPIC_DEFAULT_*_MODEL for the selected family > ANTHROPIC_MODEL fallback > original modelId
 *
 * IMPORTANT: The `[1m]` suffix is controlled by the input modelId from the
 * webview, not by stale settings.env mappings.
 * The 1M context window is selected by the Claude Code SDK based on whether the
 * model name ends with `[1m]` (it reads `process.env.ANTHROPIC_DEFAULT_*_MODEL`).
 * If the request enables 1M, preserve or append the suffix on the mapped model.
 * If the request disables 1M, strip any suffix from the mapped value so an old
 * settings.json env value cannot force the 1M context window back on.
 *
 * @param {string} modelId - Internal model ID from frontend (e.g. 'claude-sonnet-4-6' or 'claude-sonnet-4-6[1m]')
 * @param {object} userEnv - The env object from settings.json (settings.env)
 * @returns {string} The resolved model name for API calls, with the `[1m]` suffix preserved
 */
export function resolveModelFromSettings(modelId, userEnv) {
  if (!modelId || !userEnv) return modelId;

  // cc-switch ids already select a provider and model. The upstream model (or
  // provider key) can contain a Claude family name; never remap that route.
  if (modelId.startsWith('ccs-claude-')) return modelId;

  const lowerModel = modelId.toLowerCase();
  const requestHas1M = /\[1m\]$/i.test(modelId);
  // The request owns 1M state. Settings mappings may provide the provider's base
  // model ID, but they must not force the context-window suffix.
  const applySuffix = (mapped) => {
    const base = String(mapped).trim().replace(/\[1m\]$/i, '');
    return requestHas1M ? `${base}[1m]` : base;
  };

  const readMapped = (key) => {
    const mapped = userEnv[key];
    return mapped && String(mapped).trim() ? applySuffix(String(mapped).trim()) : null;
  };

  // Check family-specific env vars first. A stale generic mapping must not
  // silently route a selected Haiku/Sonnet/Opus model to another family.
  if (lowerModel.includes('fable')) {
    return readMapped('ANTHROPIC_DEFAULT_FABLE_MODEL')
      || readMapped('ANTHROPIC_MODEL')
      || modelId;
  } else if (lowerModel.includes('opus')) {
    return readMapped('ANTHROPIC_DEFAULT_OPUS_MODEL')
      || readMapped('ANTHROPIC_MODEL')
      || modelId;
  } else if (lowerModel.includes('haiku')) {
    return readMapped('ANTHROPIC_DEFAULT_HAIKU_MODEL')
      || readMapped('ANTHROPIC_MODEL')
      || modelId;
  } else if (lowerModel.includes('sonnet')) {
    // Only apply sonnet mapping when the model ID actually contains 'sonnet'.
    // Non-Anthropic model names (e.g. 'qwen3.5-plus', 'deepseek-v3') should NOT be
    // remapped to the sonnet setting, as they are already the intended model name.
    return readMapped('ANTHROPIC_DEFAULT_SONNET_MODEL')
      || readMapped('ANTHROPIC_MODEL')
      || modelId;
  }
  // For non-Anthropic model IDs that don't contain 'fable'/'opus'/'haiku'/'sonnet',
  // skip mapping and use the original model ID as-is.

  // No mapping configured, use original model ID
  return modelId;
}

/**
 * Model tier env vars: a subagent can declare its model with a tier alias in its own
 * definition (e.g. `model: opus`), and Claude Code resolves that alias to a concrete
 * model name through these keys. This lists every key that takes part in resolution.
 *
 * ANTHROPIC_MODEL is deliberately excluded: it means "global default model" and belongs
 * to the current request rather than settings.json, so setModelEnvironmentVariables()
 * owns it exclusively on every turn (keeping stale values from issue #1509 at bay).
 */
export const MODEL_TIER_ENV_KEYS = Object.freeze([
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
]);

/**
 * Read every tier mapping the user configured from the settings.json env block.
 * Only non-blank tiers are returned, so callers can assign the result directly
 * without blanking a tier the user never configured.
 *
 * @param {Object} settingsEnv - the env object of ~/.claude/settings.json
 * @returns {Object.<string, string>} configured tier key/value pairs
 */
export function readConfiguredModelTiers(settingsEnv) {
  if (!settingsEnv || typeof settingsEnv !== 'object') {
    return {};
  }

  const tiers = {};
  for (const key of MODEL_TIER_ENV_KEYS) {
    const value = settingsEnv[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      tiers[key] = String(value).trim();
    }
  }
  return tiers;
}

/**
 * Set SDK environment variables based on the model name.
 * The Claude SDK uses short names (opus/sonnet/haiku) as model selectors,
 * while the specific version is determined by ANTHROPIC_DEFAULT_*_MODEL environment variables.
 *
 * NOTE: This function mutates process.env as a side effect, which is required by the
 * Claude SDK's model resolution mechanism. This is safe in the current single-request
 * architecture but should be revisited if concurrent request handling is introduced.
 *
 * @param {string} modelId - The resolved model name to set as env var value (e.g. 'MiniMax-M2.5' or 'claude-opus-4-6')
 * @param {string} [baseModelId] - The original internal model ID used to determine which env var to set.
 *                                  Required when modelId is a custom name that doesn't contain 'opus'/'haiku'/'sonnet'.
 *                                  Falls back to modelId if not provided.
 * @param {Object} [settingsEnv] - the env block of ~/.claude/settings.json. When present it is the
 *                                  single source of truth for tiers (configured ones are written,
 *                                  unconfigured ones are cleared); when absent only the current tier
 *                                  is written and other tiers are left untouched.
 */
export function setModelEnvironmentVariables(modelId, baseModelId, settingsEnv) {
  if (!modelId || typeof modelId !== 'string') {
    return;
  }

  // Sync every tier against settings.json: configured tiers go into process.env,
  // unconfigured ones are cleared.
  //
  // Why writing them all matters: setting only the tier the current request belongs to
  // means a subagent declaring `model: opus` cannot find ANTHROPIC_DEFAULT_OPUS_MODEL and
  // falls back to the CLI's built-in Anthropic model name. Third-party endpoints do not
  // recognize that name and tend to silently route to some default model without erroring.
  // This is the only path that actually takes effect: measurements show the inline
  // `--settings` env block is not adopted by the CLI (see buildWebviewControlledSettingsOverride),
  // so tiers have to travel through process env.
  //
  // Why clearing matters just as much: the daemon is long-lived, and daemon.js's savedEnv
  // restore skips these webview-controlled vars (isWebviewControlledEnvVar), so stale values
  // never disappear on their own. Switching between Claude providers does not restart the
  // daemon either (only Claude -> non-Claude does), so when the new provider configures fewer
  // tiers, values left behind by the previous one make subagents resolve to a retired model.
  //
  // Without settingsEnv (non-daemon paths) other tiers are left alone; only the current
  // tier is written by the logic below.
  if (settingsEnv && typeof settingsEnv === 'object') {
    const configuredTiers = readConfiguredModelTiers(settingsEnv);
    for (const key of MODEL_TIER_ENV_KEYS) {
      const value = configuredTiers[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  // Use baseModelId to determine model category (which env var to set).
  // This is necessary when modelId is a custom name like 'MiniMax-M2.5'
  // that doesn't contain 'opus'/'haiku'/'sonnet'.
  const lowerBase = (baseModelId || modelId).toLowerCase();

  process.env.ANTHROPIC_MODEL = modelId;

  // Set the corresponding environment variable based on model type
  // so the SDK knows which specific version to use
  if (lowerBase.includes('fable')) {
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_FABLE_MODEL =', modelId);
  } else if (lowerBase.includes('opus')) {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_OPUS_MODEL =', modelId);
  } else if (lowerBase.includes('haiku')) {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_HAIKU_MODEL =', modelId);
  } else {
    // Covers 'sonnet' and any non-Anthropic model names (e.g. 'qwen3.5-plus', 'deepseek-v3')
    // Since mapModelIdToSdkName() defaults to 'sonnet' for unknown models,
    // the SDK will look up ANTHROPIC_DEFAULT_SONNET_MODEL for the actual model name
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_SONNET_MODEL =', modelId);
  }
}

// Note: getClaudeCliPath() has been removed.
// Now using the SDK's built-in cli.js (at node_modules/@anthropic-ai/claude-agent-sdk/cli.js).
// This avoids system CLI path issues on Windows (ENOENT errors) and keeps the version aligned with the SDK.

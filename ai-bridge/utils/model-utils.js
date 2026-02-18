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
  // - Contains 'opus' -> 'opus'
  // - Contains 'haiku' -> 'haiku'
  // - Otherwise (contains 'sonnet' or unknown) -> 'sonnet'
  if (lowerModel.includes('opus')) {
    return 'opus';
  } else if (lowerModel.includes('haiku')) {
    return 'haiku';
  } else {
    return 'sonnet';
  }
}

/**
 * Set SDK environment variables based on the full model ID.
 * The Claude SDK uses short names (opus/sonnet/haiku) as model selectors,
 * while the specific version is determined by ANTHROPIC_DEFAULT_*_MODEL environment variables.
 *
 * @param {string} modelId - Full model ID (e.g. 'claude-opus-4-6')
 */
export function setModelEnvironmentVariables(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    return;
  }

  const lowerModel = modelId.toLowerCase();

  // Set the corresponding environment variable based on model type
  // so the SDK knows which specific version to use
  if (lowerModel.includes('opus')) {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_OPUS_MODEL =', modelId);
  } else if (lowerModel.includes('haiku')) {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_HAIKU_MODEL =', modelId);
  } else if (lowerModel.includes('sonnet')) {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_SONNET_MODEL =', modelId);
  }
}

// Note: getClaudeCliPath() has been removed.
// Now using the SDK's built-in cli.js (at node_modules/@anthropic-ai/claude-agent-sdk/cli.js).
// This avoids system CLI path issues on Windows (ENOENT errors) and keeps the version aligned with the SDK.

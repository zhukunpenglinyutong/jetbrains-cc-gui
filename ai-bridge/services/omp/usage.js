/**
 * Normalize OMP token reports onto the Claude usage schema that the `[USAGE]`
 * marker carries.
 *
 * OMP reports usage on every assistant message, one model step each:
 *   { input, output, cacheRead, cacheWrite, totalTokens, cost: { total } }
 * `input` already excludes cached tokens. OMP prices the step itself, so
 * `cost.total` travels as `cost_usd` and a subscription or local model is not
 * billed at list price by the plugin's static tables.
 */

function toCount(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * @param {object} usage OMP assistant-message usage
 * @param {number} [contextWindow] context window of the session's model
 * @returns {object|null} usage in Claude schema, or null without positive figures
 */
export function normalizeOmpUsage(usage, contextWindow) {
  if (!usage || typeof usage !== 'object') return null;
  const input = toCount(usage.input);
  const output = toCount(usage.output);
  const cacheRead = toCount(usage.cacheRead);
  const cacheWrite = toCount(usage.cacheWrite);
  const total = toCount(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  if (total <= 0) return null;

  const normalized = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    total_tokens: total,
  };
  const cost = usage.cost && typeof usage.cost === 'object' ? usage.cost.total : undefined;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
    normalized.cost_usd = cost;
  }
  const window = toCount(contextWindow);
  if (window > 0) {
    normalized.model_context_window = window;
  }
  return normalized;
}

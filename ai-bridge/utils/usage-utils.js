/**
 * Shared usage accumulation utilities for streaming token tracking.
 * Used by message-service.js and persistent-query-service.js.
 */

export const DEFAULT_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0
};

/**
 * Merge usage data following CLI's nz6() logic.
 * - input_tokens, cache_*: only update if new value > 0 (preserve accumulated)
 * - output_tokens: use new value directly (incremental updates)
 */
export function mergeUsage(accumulated, newUsage) {
  if (!newUsage) return accumulated || { ...DEFAULT_USAGE };
  if (!accumulated) return { ...DEFAULT_USAGE, ...newUsage };
  return {
    input_tokens: newUsage.input_tokens > 0 ? newUsage.input_tokens : accumulated.input_tokens,
    cache_creation_input_tokens: newUsage.cache_creation_input_tokens > 0
      ? newUsage.cache_creation_input_tokens : accumulated.cache_creation_input_tokens,
    cache_read_input_tokens: newUsage.cache_read_input_tokens > 0
      ? newUsage.cache_read_input_tokens : accumulated.cache_read_input_tokens,
    output_tokens: newUsage.output_tokens ?? accumulated.output_tokens
  };
}

/**
 * Emit [USAGE] tag from accumulated usage data during streaming.
 * NOTE: The console.log below is intentional IPC — the Java backend parses
 * stdout lines starting with "[USAGE]" to extract token metrics.
 */
export function emitAccumulatedUsage(accumulated) {
  if (!accumulated) return;
  console.log('[USAGE]', JSON.stringify({
    input_tokens: accumulated.input_tokens || 0,
    output_tokens: accumulated.output_tokens || 0,
    cache_creation_input_tokens: accumulated.cache_creation_input_tokens || 0,
    cache_read_input_tokens: accumulated.cache_read_input_tokens || 0
  }));
}

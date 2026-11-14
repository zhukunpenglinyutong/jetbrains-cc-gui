/**
 * Normalize OpenCode token reports onto the Claude usage schema that the
 * `[USAGE]` marker carries (input_tokens excludes cache reads).
 *
 * OpenCode reports usage once per model step (`step_finish`). Each report
 * covers that step only; the Java side keeps the latest report for the
 * context ring and sums them for the per-turn footer.
 */

const USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'total_tokens',
];

function toCount(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function asObject(value) {
  return value && typeof value === 'object' ? value : null;
}

function buildUsage({ input, output, cacheRead, cacheWrite, reasoning, total }) {
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0 && total <= 0) {
    return null;
  }
  const usage = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    total_tokens: total,
  };
  return reasoning > 0 ? { ...usage, thinking_tokens: reasoning } : usage;
}

function fromOpenCodeTokens(tokens) {
  const rawInput = toCount(tokens.input);
  const output = toCount(tokens.output);
  const reasoning = toCount(tokens.reasoning);
  const cache = asObject(tokens.cache);
  const cacheRead = toCount(cache?.read ?? tokens.cache_read ?? tokens.cached);
  const cacheWrite = toCount(cache?.write ?? tokens.cache_write);
  const rawTotal = toCount(tokens.total);

  // OpenCode's tokens.input is cache-exclusive (total = input + cache.read +
  // cache.write + output + reasoning). A backend whose input already includes
  // cache.read shows up as a total that adds up without cache.read.
  const inputIncludesCache = rawTotal > 0
    && cacheRead > 0
    && rawInput >= cacheRead
    && rawInput + cacheWrite + output + reasoning === rawTotal;
  const input = inputIncludesCache ? rawInput - cacheRead : rawInput;
  const total = rawTotal > 0 ? rawTotal : input + cacheRead + cacheWrite + output + reasoning;
  return buildUsage({ input, output, cacheRead, cacheWrite, reasoning, total });
}

function fromOpenAiUsage(rawUsage) {
  const prompt = toCount(rawUsage.prompt_tokens);
  const output = toCount(rawUsage.completion_tokens);
  const details = asObject(rawUsage.prompt_tokens_details);
  const cacheRead = toCount(details?.cached_tokens ?? rawUsage.cached_tokens ?? rawUsage.cache_read_input_tokens);
  const cacheWrite = toCount(details?.cache_creation_tokens ?? rawUsage.cache_creation_input_tokens);
  const reasoning = toCount(rawUsage.completion_tokens_details?.reasoning_tokens ?? rawUsage.thinking_tokens);
  const input = prompt >= cacheRead ? prompt - cacheRead : prompt;
  const total = toCount(rawUsage.total_tokens) || input + cacheRead + cacheWrite + output;
  return buildUsage({ input, output, cacheRead, cacheWrite, reasoning, total });
}

function fromClaudeUsage(rawUsage) {
  const input = toCount(rawUsage.input_tokens);
  const output = toCount(rawUsage.output_tokens);
  const cacheRead = toCount(rawUsage.cache_read_input_tokens);
  const cacheWrite = toCount(rawUsage.cache_creation_input_tokens);
  const reasoning = toCount(rawUsage.thinking_tokens);
  const total = toCount(rawUsage.total_tokens) || input + cacheRead + cacheWrite + output + reasoning;
  return buildUsage({ input, output, cacheRead, cacheWrite, reasoning, total });
}

function fromUsageObject(rawUsage) {
  // prompt_tokens / completion_tokens only exist in the OpenAI shape; a bare
  // total_tokens is also part of the Claude-schema payload this module emits.
  if (rawUsage.prompt_tokens !== undefined || rawUsage.completion_tokens !== undefined) {
    return fromOpenAiUsage(rawUsage);
  }
  if (USAGE_KEYS.some((key) => rawUsage[key] !== undefined)) {
    return fromClaudeUsage(rawUsage);
  }
  return null;
}

function readCostUsd(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Extract usage from an OpenCode event: `part.tokens` on step_finish, or a
 * usage object in OpenAI / Claude shape from compatible backends.
 *
 * OpenCode prices each step itself (`part.cost`); that figure is passed on as
 * `cost_usd` so a subscription or local model is not billed at list price.
 *
 * @param {object} event parsed OpenCode JSON event
 * @returns {object|null} usage in Claude schema, or null without positive figures
 */
export function extractOpenCodeUsage(event) {
  if (!event || typeof event !== 'object') return null;
  const part = asObject(event.part);
  const tokens = asObject(part?.tokens) || asObject(event.tokens);
  if (tokens) {
    const usage = fromOpenCodeTokens(tokens);
    const costUsd = readCostUsd(part?.cost ?? event.cost);
    return usage && costUsd !== null ? { ...usage, cost_usd: costUsd } : usage;
  }

  const rawUsage = asObject(part?.usage) || asObject(event.usage) || asObject(event.message?.usage);
  return rawUsage ? fromUsageObject(rawUsage) : null;
}

/**
 * Thinking settings for the lightweight "ask" requests (commit message, prompt
 * enhancer, session title).
 *
 * These requests want a short text answer, so thinking is turned off wherever the
 * model allows it: reasoning models behind relays (e.g. DeepSeek) otherwise spend
 * max_tokens on thinking blocks and return empty text (#1693). Newer Claude models
 * reject `thinking: { type: 'disabled' }` with HTTP 400 (#1949), so each family
 * gets the form it accepts.
 */

// Thinking tokens count against max_tokens, so leave room for the text when thinking stays on.
const THINKING_ON_MIN_MAX_TOKENS = 4096;

const CLAUDE_VERSION_PATTERN = /claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/;

/**
 * Extract family and version from a Claude model id.
 * Matches anywhere in the id so provider prefixes (`us.anthropic.`) and suffixes
 * (`[1m]`, date stamps) do not matter. The `(?!\d)` keeps an 8-digit date stamp
 * from being read as a minor version.
 * @param {unknown} modelId
 * @returns {{ family: string, major: number, minor: number } | null} null for non-Claude ids
 */
export function parseClaudeModelVersion(modelId) {
  if (typeof modelId !== 'string') return null;
  const match = CLAUDE_VERSION_PATTERN.exec(modelId.toLowerCase());
  if (!match) return null;
  return {
    family: match[1],
    major: Number(match[2]),
    minor: match[3] === undefined ? 0 : Number(match[3]),
  };
}

function isAtLeast(version, major, minor) {
  return version.major > major || (version.major === major && version.minor >= minor);
}

/**
 * Pick the request fields that control thinking for a short ask request.
 * - Fable / Mythos 5.x and Opus >= 5.5 cannot turn thinking off: omit `thinking`
 *   (adaptive) and keep it short with a low effort.
 * - Sonnet >= 5.5 turns it off with `between_tools`; `disabled` is a 400 there.
 * - Everything else, including unknown relay models, gets `disabled`. Relays that
 *   reject it are handled by createWithThinkingFallback.
 * @param {string} modelId
 * @param {number} maxTokens
 * @returns {object} fields to spread into the request
 */
export function buildAskThinkingFields(modelId, maxTokens) {
  const version = parseClaudeModelVersion(modelId);
  if (version) {
    const alwaysOn =
      ((version.family === 'fable' || version.family === 'mythos') && version.major >= 5) ||
      (version.family === 'opus' && isAtLeast(version, 5, 5));
    if (alwaysOn) {
      return {
        max_tokens: Math.max(maxTokens, THINKING_ON_MIN_MAX_TOKENS),
        output_config: { effort: 'low' },
      };
    }
    if (version.family === 'sonnet' && isAtLeast(version, 5, 5)) {
      return { max_tokens: maxTokens, thinking: { type: 'between_tools' } };
    }
  }
  return { max_tokens: maxTokens, thinking: { type: 'disabled' } };
}

/**
 * Whether an SDK error is a 400 caused by the thinking setting. Relays word this
 * differently (Anthropic, MiniMax), so match on the word in the message or body.
 * @param {any} err
 * @returns {boolean}
 */
export function isThinkingRejection(err) {
  if (Number(err?.status) !== 400) return false;
  const text = `${err.message ?? ''} ${err.error ? JSON.stringify(err.error) : ''}`;
  return /thinking/i.test(text);
}

/**
 * Copy of the request without `thinking`, for retrying against a relay that
 * rejected it. The model then thinks adaptively, so max_tokens is raised to leave
 * room for the text.
 * @param {object} request
 * @returns {object | null} null when there is nothing to remove
 */
export function withoutThinking(request) {
  if (!request || !Object.prototype.hasOwnProperty.call(request, 'thinking')) return null;
  const { thinking: _thinking, ...rest } = request;
  if (typeof rest.max_tokens === 'number') {
    rest.max_tokens = Math.max(rest.max_tokens, THINKING_ON_MIN_MAX_TOKENS);
  }
  return rest;
}

/**
 * Run `create(request)`; on a thinking-related 400, retry once without `thinking`.
 * Does not log: the session-title service runs in a daemon whose stdout is a
 * JSON-line protocol, so callers report the retry through `onRetry`.
 * @param {(request: object) => Promise<any>} create
 * @param {object} request
 * @param {{ onRetry?: (err: any) => void }} [options]
 */
export async function createWithThinkingFallback(create, request, { onRetry } = {}) {
  try {
    return await create(request);
  } catch (err) {
    const retry = withoutThinking(request);
    if (!retry || !isThinkingRejection(err)) throw err;
    onRetry?.(err);
    return create(retry);
  }
}

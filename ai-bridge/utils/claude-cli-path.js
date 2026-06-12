/**
 * Resolves the user-configured Claude Code CLI executable, if any.
 *
 * The Java daemon sets CLAUDE_CODE_PATH when the user has provided a custom
 * path in Settings > Basic. When set, the Claude Agent SDK is told to spawn
 * that binary instead of its bundled CLI via `pathToClaudeCodeExecutable`.
 *
 * Returns null when unset/blank so callers can spread the field conditionally.
 */
export function getClaudeCliPathOverride() {
  const raw = process.env.CLAUDE_CODE_PATH;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reformat Claude-style line references for pi/omp CLIs.
 *
 * pi/omp cannot parse `@path#L1` / `@path#L1-5`:
 * - pi (upstream pi-mono) has no @-mention expansion in prompt text at all;
 *   the token is plain text for the model.
 * - omp's mention regex keeps `#L1` glued to the path, the file lookup misses
 *   and the mention is silently dropped, so the file is never attached.
 *
 * Rewriting to `@path` + prose keeps the mention resolvable (omp auto-attaches
 * the file) and preserves the line information as text both CLIs' models can
 * act on with their file tools.
 */

// The `@` must start the string or follow whitespace (`(?<!\S)`). Without the
// anchor, mid-word `@` false-positives get mangled: `user@host.com#L5` would
// become `user@host.com (lines 5)`, and refs quoted in code spans like
// `` `@x/Y.java#L3` `` would be rewritten inside the user's pasted code.
// Trade-off: `(@file#L1)` (parenthesized) is left untouched — acceptable,
// since the plugin always emits references at a token boundary.
const LINE_REFERENCE_PATTERN = /(?<!\S)@([^\s@]+)#L(\d+)(?:-L?(\d+))?/g;

/**
 * @param {string} text
 * @returns {string} text with `@path#L1[-L2]` rewritten to `@path (lines 1[-2])`
 */
export function reformatFileLineReferences(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(LINE_REFERENCE_PATTERN, (match, filePath, startLine, endLine) =>
    endLine
      ? `@${filePath} (lines ${startLine}-${endLine})`
      : `@${filePath} (lines ${startLine})`
  );
}

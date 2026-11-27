import type { ToolInput, ToolResultBlock } from '../types';
import { extractResultText } from './subagentResult';

const FLAT_CUA_REPL_TOOL = /^mcp__cua_repl(?:__|\.)/i;

const BROWSER_ACCESS_ERRORS = [
  'browser access host is unavailable',
  'could not verify whether the current browser url is allowed',
];

/** A failed call of an external browser tool (cua_repl) that could not reach the user's browser. */
export function isBrowserAccessError(
  name: string | undefined,
  input: ToolInput | undefined,
  result: ToolResultBlock | null | undefined,
): boolean {
  if (result?.is_error !== true) return false;
  if (input?.server !== 'cua_repl' && !FLAT_CUA_REPL_TOOL.test(name ?? '')) return false;
  const text = (extractResultText(result) ?? '').toLowerCase();
  return BROWSER_ACCESS_ERRORS.some((error) => text.includes(error));
}

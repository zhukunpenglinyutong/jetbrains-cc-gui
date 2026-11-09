import type { PatchFile } from './codexPatch';
import { normalizeToolName } from './toolConstants';
import { isAbsolutePath } from './toolPresentation';

type ToolInputRecord = Record<string, unknown>;

/** Tool names only the JetBrains MCP server provides, so a bare name still means MCP. */
const JETBRAINS_ONLY_TOOL_NAMES = new Set(['create_new_file', 'replace_text_in_file']);

/** Codex projects an MCP call as `{ server, arguments }`, both live and from history. */
function isWrappedMcpInput(input: ToolInputRecord): boolean {
  const args = input.arguments;
  return typeof input.server === 'string' && Boolean(args) && typeof args === 'object' && !Array.isArray(args);
}

/** Recognizes both the wrapped Codex shape and a flat call under an `mcp__server__tool` name. */
export function isMcpToolCall(rawName: string | undefined, input: ToolInputRecord): boolean {
  const name = rawName ?? '';
  return isWrappedMcpInput(input) || /^(?:(?:tools|functions|collaboration)\.)?mcp__/i.test(name.trim())
    || JETBRAINS_ONLY_TOOL_NAMES.has(normalizeToolName(name));
}

/** Lifts wrapped MCP arguments to the top level, where the file ledger reads tool fields. */
export function unwrapMcpArguments(input: ToolInputRecord): ToolInputRecord {
  return isWrappedMcpInput(input) ? { ...input, ...(input.arguments as ToolInputRecord) } : input;
}

/**
 * Joins a project-relative tool path onto the root the call named, in the root's
 * separators, so one file keeps one ledger row however the call spelled its path.
 */
function resolveInProject(path: string, projectPath: unknown): string {
  if (typeof projectPath !== 'string' || !projectPath.trim() || isAbsolutePath(path)) return path;
  const root = projectPath.trim().replace(/[\\/]+$/, '');
  const separator = root.includes('\\') ? '\\' : '/';
  const relative = path.replace(/^(?:\.[\\/]+)+/, '').replace(/[\\/]+/g, separator);
  return `${root}${separator}${relative}`;
}

/** The JetBrains MCP target of a file tool, or null when the call has none. */
export function readPathInProject(input: ToolInputRecord): string | null {
  const path = input.pathInProject;
  return typeof path === 'string' && path.trim() ? resolveInProject(path, input.projectPath) : null;
}

/** MCP patches address files from the project root, unlike native absolute changes. */
export function patchFileInProject(file: PatchFile, projectPath: unknown): PatchFile {
  return {
    ...file,
    path: resolveInProject(file.path, projectPath),
    ...(file.movePath ? { movePath: resolveInProject(file.movePath, projectPath) } : {}),
  };
}

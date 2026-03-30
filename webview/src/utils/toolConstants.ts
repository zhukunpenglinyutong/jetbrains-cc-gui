/**
 * Tool name constants for consistent tool identification across the application.
 * Centralizes tool name definitions to prevent inconsistencies.
 */

// Read/file viewing tools
export const READ_TOOL_NAMES = new Set(['read', 'read_file', 'read_multiple_files']);

// Edit/file modification tools
export const EDIT_TOOL_NAMES = new Set(['edit', 'edit_file', 'replace_string', 'write_to_file']);

// Bash/command execution tools
export const BASH_TOOL_NAMES = new Set(['bash', 'run_terminal_cmd', 'execute_command', 'shell_command']);

// Search/grep/glob tools
export const SEARCH_TOOL_NAMES = new Set(['grep', 'glob', 'search', 'find', 'search_files']);

// Internal orchestration tools that may be useful during streaming but should
// not remain as residual tool cards after the final answer is complete.
export const TRANSIENT_INTERNAL_TOOL_NAMES = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'parallel',
  'multi_tool_use.parallel',
]);

// File modification tools (for rewind feature - includes write for new file creation)
export const FILE_MODIFY_TOOL_NAMES = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'replace_string',
  'write_to_file',
  'notebookedit',
  'create_file',
]);

export function normalizeToolName(toolName: string): string {
  const lower = toolName.toLowerCase();
  const mcpMatch = /^mcp__[^_]+__(.+)$/.exec(lower);
  return mcpMatch ? mcpMatch[1] : lower;
}

/**
 * Check if a tool name matches a set of tool names (case-insensitive)
 */
export function isToolName(toolName: string | undefined, toolSet: Set<string>): boolean {
  return toolName !== undefined && toolSet.has(normalizeToolName(toolName));
}

export function isTransientInternalToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  return TRANSIENT_INTERNAL_TOOL_NAMES.has(lower) || TRANSIENT_INTERNAL_TOOL_NAMES.has(normalizeToolName(lower));
}

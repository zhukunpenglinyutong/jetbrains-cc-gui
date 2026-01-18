/**
 * Tool name constants for consistent tool identification across the application.
 * Centralizes tool name definitions to prevent inconsistencies.
 */

// Read/file viewing tools
export const READ_TOOL_NAMES = new Set(['read', 'read_file']);

// Edit/file modification tools
export const EDIT_TOOL_NAMES = new Set(['edit', 'edit_file', 'replace_string', 'write_to_file']);

// Bash/command execution tools
export const BASH_TOOL_NAMES = new Set(['bash', 'run_terminal_cmd', 'execute_command', 'shell_command']);

// File modification tools (for rewind feature - includes write for new file creation)
export const FILE_MODIFY_TOOL_NAMES = new Set([
  'write',
  'edit',
  'edit_file',
  'replace_string',
  'write_to_file',
  'notebookedit',
  'create_file',
]);

/**
 * Check if a tool name matches a set of tool names (case-insensitive)
 */
export function isToolName(toolName: string | undefined, toolSet: Set<string>): boolean {
  return toolName !== undefined && toolSet.has(toolName.toLowerCase());
}

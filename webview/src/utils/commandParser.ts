/**
 * Command parsing utilities for extracting file paths from shell commands
 * Used by tool blocks to display file information from Codex commands
 */

/**
 * Extract file/directory path from command string (for Codex commands)
 * Returns the path with optional metadata suffix (e.g., ":700-780" for line ranges, "/" for directories)
 *
 * @param command - The shell command string to parse
 * @param workdir - Optional working directory for relative path resolution
 * @returns The extracted file path or undefined if not found
 */
export const extractFilePathFromCommand = (
  command: string | undefined,
  workdir?: string
): string | undefined => {
  if (!command || typeof command !== 'string') return undefined;

  let trimmed = command.trim();

  // Extract actual command from shell wrapper (/bin/zsh -lc '...' or /bin/bash -c '...')
  const shellWrapperMatch = trimmed.match(/^\/bin\/(zsh|bash)\s+(?:-lc|-c)\s+['"](.+)['"]$/);
  if (shellWrapperMatch) {
    trimmed = shellWrapperMatch[2];
  }

  // Remove 'cd dir &&' prefix if present
  const cdPrefixMatch = trimmed.match(/^cd\s+\S+\s+&&\s+(.+)$/);
  if (cdPrefixMatch) {
    trimmed = cdPrefixMatch[1].trim();
  }

  // Match pwd command - returns current directory from workdir
  if (/^pwd\s*$/.test(trimmed)) {
    return workdir ? workdir + '/' : undefined;
  }

  // Match ls command (with or without flags)
  // Examples: ls, ls -a, ls -la, ls /path, ls -a /path
  const lsMatch = trimmed.match(/^ls\s+(?:-[a-zA-Z]+\s+)?(.+)$/);
  if (lsMatch) {
    const path = lsMatch[1].trim().replace(/^["']|["']$/g, '');
    // Add trailing slash to indicate directory
    return path.endsWith('/') ? path : path + '/';
  }

  // Match ls without path (current directory)
  if (/^ls(?:\s+-[a-zA-Z]+)*\s*$/.test(trimmed)) {
    return workdir ? workdir + '/' : undefined;
  }

  // Match tree command (directory listing)
  if (/^tree\b/.test(trimmed)) {
    const treeMatch = trimmed.match(/^tree\s+(.+)$/);
    if (treeMatch) {
      const path = treeMatch[1].trim().replace(/^["']|["']$/g, '');
      return path.endsWith('/') ? path : path + '/';
    }
    return workdir ? workdir + '/' : undefined;
  }

  // Match sed -n command (e.g., sed -n '700,780p' file.txt)
  const sedMatch = trimmed.match(/^sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+(.+)$/);
  if (sedMatch) {
    const startLine = sedMatch[1];
    const endLine = sedMatch[2];
    const path = sedMatch[3].trim().replace(/^["']|["']$/g, '');

    // Return file path with line range info
    if (endLine) {
      return `${path}:${startLine}-${endLine}`;
    } else {
      return `${path}:${startLine}`;
    }
  }

  // Match cat command (simple case without flags)
  const catMatch = trimmed.match(/^cat\s+(.+)$/);
  if (catMatch) {
    const path = catMatch[1].trim();
    // Remove quotes if present
    return path.replace(/^["']|["']$/g, '');
  }

  // Match head/tail commands (may have flags like -n 10)
  const headTailMatch = trimmed.match(/^(head|tail)\s+(?:.*\s)?([^\s-][^\s]*)$/);
  if (headTailMatch) {
    const path = headTailMatch[2].trim();
    // Remove quotes if present
    return path.replace(/^["']|["']$/g, '');
  }

  return undefined;
};

/**
 * Check if a shell command is a file/directory viewing operation
 *
 * @param command - The shell command string to check
 * @returns true if the command is a file viewing operation
 */
export const isFileViewingCommand = (command?: string): boolean => {
  if (!command || typeof command !== 'string') return false;
  const trimmed = command.trim();
  // File viewing: pwd, ls, cat, head, tail, sed -n, tree
  return /^(pwd|ls|cat|head|tail|tree|file|stat)\b/.test(trimmed) ||
         /^sed\s+-n\s+/.test(trimmed);
};

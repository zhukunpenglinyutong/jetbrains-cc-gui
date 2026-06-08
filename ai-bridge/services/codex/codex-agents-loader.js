/**
 * AGENTS.md discovery and session file management for Codex.
 * Collects agent instructions from project directories and finds session files.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { getRealHomeDir } from '../../utils/path-utils.js';
import { MAX_AGENTS_MD_BYTES, AGENTS_FILE_NAMES, SESSION_PATCH_SCAN_MAX_FILES, logWarn, logInfo, logDebug } from './codex-utils.js';

function getCodexSessionsRoot() {
  return process.env.CODEX_SESSIONS_DIR && process.env.CODEX_SESSIONS_DIR.trim()
    ? process.env.CODEX_SESSIONS_DIR.trim()
    : join(getRealHomeDir(), '.codex', 'sessions');
}

/**
 * Finds a session file containing the threadId under ~/.codex/sessions.
 */
export function findSessionFileByThreadId(threadId) {
  if (!threadId || typeof threadId !== 'string') {
    return null;
  }

  const sessionsRoot = getCodexSessionsRoot();
  if (!existsSync(sessionsRoot)) {
    return null;
  }

  const stack = [sessionsRoot];
  let visited = 0;

  while (stack.length > 0 && visited < SESSION_PATCH_SCAN_MAX_FILES) {
    const current = stack.pop();
    if (!current) continue;
    visited += 1;

    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
        return fullPath;
      }
    }
  }

  return null;
}

/**
 * Find the Git repository root directory.
 * @param {string} startDir - Starting directory
 * @returns {string|null} Git root directory or null
 */
export function findGitRoot(startDir) {
  let currentDir = startDir;

  while (currentDir) {
    const gitDir = join(currentDir, '.git');
    if (existsSync(gitDir)) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached the filesystem root
      break;
    }
    currentDir = parentDir;
  }
  return null;
}

/**
 * Search for an AGENTS.md file in a single directory.
 * @param {string} dir - Directory to search
 * @returns {string|null} Found file path or null
 */
export function findAgentsFileInDir(dir) {
  for (const fileName of AGENTS_FILE_NAMES) {
    const filePath = join(dir, fileName);
    try {
      if (existsSync(filePath)) {
        const stats = statSync(filePath);
        if (stats.isFile() && stats.size > 0) {
          return filePath;
        }
      }
    } catch (e) {
      // Ignore permission errors, etc.
    }
  }
  return null;
}

/**
 * Read the contents of an AGENTS.md file.
 * @param {string} filePath - File path
 * @returns {string} File content (may be truncated)
 */
export function readAgentsFile(filePath) {
  try {
    const stats = statSync(filePath);
    const content = readFileSync(filePath, 'utf8');
    if (content.length > MAX_AGENTS_MD_BYTES) {
      logInfo('AGENTS.md', `File truncated from ${content.length} to ${MAX_AGENTS_MD_BYTES} bytes: ${filePath}`);
      return content.slice(0, MAX_AGENTS_MD_BYTES);
    }
    return content;
  } catch (e) {
    logWarn('AGENTS.md', `Failed to read file: ${filePath}`, e.message);
    return '';
  }
}

/**
 * Collect all AGENTS.md instructions (from project root to current directory).
 *
 * Search rules (consistent with Codex CLI):
 * 1. Global instructions: ~/.codex/AGENTS.override.md or ~/.codex/AGENTS.md
 * 2. Project instructions: every directory from git root to cwd
 *
 * @param {string} cwd - Current working directory
 * @returns {string} Merged instruction content
 */
export function collectAgentsInstructions(cwd) {
  if (!cwd || typeof cwd !== 'string') {
    return '';
  }

  const instructions = [];
  let totalBytes = 0;

  // 1. First read global instructions (~/.codex/)
  const codexHome = (process.env.CODEX_HOME && process.env.CODEX_HOME.trim())
    ? process.env.CODEX_HOME.trim()
    : join(getRealHomeDir(), '.codex');
  const globalFile = findAgentsFileInDir(codexHome);
  if (globalFile) {
    const content = readAgentsFile(globalFile);
    if (content.trim()) {
      logInfo('AGENTS.md', `Loaded global instructions: ${globalFile}`);
      instructions.push(`# Global Instructions (${globalFile})\n\n${content}`);
      totalBytes += content.length;
    }
  }

  // 2. Then read project instructions (from git root to cwd)
  const gitRoot = findGitRoot(cwd);
  const searchRoot = gitRoot || cwd;

  // Collect all directories from searchRoot to cwd
  const directories = [];
  let currentDir = cwd;
  while (currentDir) {
    directories.unshift(currentDir); // Add to the beginning to maintain root-to-leaf order
    if (currentDir === searchRoot) {
      break;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  // Read AGENTS.md from each directory in order
  for (const dir of directories) {
    if (totalBytes >= MAX_AGENTS_MD_BYTES) {
      logInfo('AGENTS.md', `Reached max bytes limit (${MAX_AGENTS_MD_BYTES}), stopping collection`);
      break;
    }

    const file = findAgentsFileInDir(dir);
    if (file) {
      const content = readAgentsFile(file);
      if (content.trim()) {
        const relativePath = dir === searchRoot ? '(root)' : dir.replace(searchRoot, '.');
        logInfo('AGENTS.md', `Loaded project instructions: ${file}`);
        instructions.push(`# Project Instructions ${relativePath}\n\n${content}`);
        totalBytes += content.length;
      }
    }
  }

  if (instructions.length === 0) {
    logDebug('AGENTS.md', 'No AGENTS.md files found');
    return '';
  }

  logInfo('AGENTS.md', `Collected ${instructions.length} instruction files, total ${totalBytes} bytes`);
  return instructions.join('\n\n---\n\n');
}

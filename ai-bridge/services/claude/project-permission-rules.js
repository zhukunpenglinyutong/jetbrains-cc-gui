import fs from 'node:fs';
import path from 'node:path';
import { getClaudeDir } from '../../utils/path-utils.js';

const PROJECT_SETTINGS_FILES = ['settings.json', 'settings.local.json'];
const RESTRICTIVE_DEFAULT_MODES = new Set(['default', 'plan']);

const GRANTING_FRONTMATTER = [
  ['agents', /^permissionMode\s*:/m],
  ['skills', /^allowed[-_]tools\s*:/m],
  ['commands', /^allowed[-_]tools\s*:/m],
];
// The scan runs on every side-effect tool call, so it is bounded. A tree too deep or too
// large to scan cannot be shown to be safe and counts as granting.
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 2000;
// Frontmatter sits at the top of the file.
const FRONTMATTER_READ_BYTES = 64 * 1024;

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isUserConfigDir(dir) {
  return [getClaudeDir(), process.env.CLAUDE_CONFIG_DIR].some(candidate => candidate && samePath(candidate, dir));
}

function nonEmpty(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function definesAutoApprove(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true;

  const permissions = settings.permissions;
  if (permissions !== undefined && permissions !== null) {
    if (typeof permissions !== 'object' || Array.isArray(permissions)) return true;
    if (nonEmpty(permissions.allow)) return true;
    if (permissions.defaultMode !== undefined && !RESTRICTIVE_DEFAULT_MODES.has(permissions.defaultMode)) return true;
  }
  if (nonEmpty(settings.allowedTools)) return true;
  if (settings.hooks && typeof settings.hooks === 'object' && nonEmpty(settings.hooks.PreToolUse)) return true;
  // An enabled sandbox auto-allows sandboxed Bash commands.
  if (nonEmpty(settings.sandbox)) return true;
  return false;
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(FRONTMATTER_READ_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether any Markdown file under root matches pattern. Directory links are followed once
 * each (realpath), so a link cannot hide a definition or loop the scan.
 */
function anyMarkdownMatches(root, pattern) {
  const visited = new Set();
  let scanned = 0;

  const walk = (dir, depth) => {
    if (depth > MAX_SCAN_DEPTH) return true;
    let entries;
    try {
      const real = fs.realpathSync(dir);
      if (visited.has(real)) return false;
      visited.add(real);
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return !isMissing(error);
    }
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_SCAN_ENTRIES) return true;
      const target = path.join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = fs.statSync(target);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch (error) {
          if (isMissing(error)) continue;
          return true;
        }
      }
      if (isDirectory) {
        if (walk(target, depth + 1)) return true;
        continue;
      }
      if (!isFile || !entry.name.toLowerCase().endsWith('.md')) continue;
      try {
        if (pattern.test(readHead(target))) return true;
      } catch {
        return true;
      }
    }
    return false;
  };

  return walk(root, 0);
}

/**
 * Whether the project's own Claude configuration in the working directory can approve
 * tool calls without asking:
 * - .claude/settings.json or .claude/settings.local.json with allow rules, a permissive
 *   default mode, a PreToolUse hook or a sandbox;
 * - an agent under .claude/agents that sets permissionMode;
 * - a skill or command under .claude/skills or .claude/commands with allowed-tools.
 *
 * All of these come with the repository, so a repository the user merely opened can ship
 * them. Anything that cannot be read, parsed or fully scanned counts as such a rule,
 * because it cannot be shown to be safe. The user's own configuration directory is never
 * treated as project configuration.
 */
export function projectHasAutoApproveRules(cwd) {
  if (!cwd || typeof cwd !== 'string') return true;

  const claudeDir = path.join(cwd, '.claude');
  if (isUserConfigDir(claudeDir)) return false;

  for (const name of PROJECT_SETTINGS_FILES) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(claudeDir, name), 'utf8');
    } catch (error) {
      if (isMissing(error)) continue;
      return true;
    }
    try {
      if (definesAutoApprove(JSON.parse(raw))) return true;
    } catch {
      return true;
    }
  }

  return GRANTING_FRONTMATTER.some(([sub, pattern]) => anyMarkdownMatches(path.join(claudeDir, sub), pattern));
}

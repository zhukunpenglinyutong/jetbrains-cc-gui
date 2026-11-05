import fs from 'node:fs';
import path from 'node:path';
import { getClaudeDir } from '../../utils/path-utils.js';

const PROJECT_SETTINGS_FILES = ['settings.json', 'settings.local.json'];
const RESTRICTIVE_DEFAULT_MODES = new Set(['default', 'plan']);

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
  return false;
}

/**
 * Whether the project's own Claude settings (.claude/settings.json and
 * .claude/settings.local.json in the working directory) can approve tool calls
 * without asking: allow rules, a permissive default mode or a PreToolUse hook.
 *
 * Those files come with the repository, so a repository the user merely opened
 * can ship them. Unreadable or unparsable settings count as such rules because
 * they cannot be shown to be safe. The user's own configuration directory is
 * never treated as project settings.
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
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      return true;
    }
    try {
      if (definesAutoApprove(JSON.parse(raw))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

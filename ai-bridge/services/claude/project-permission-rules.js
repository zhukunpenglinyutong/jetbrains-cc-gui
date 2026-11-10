import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { getClaudeDir } from '../../utils/path-utils.js';

const PROJECT_SETTINGS_FILES = ['settings.json', 'settings.local.json'];
const DEFINITION_DIRS = ['agents', 'skills', 'commands'];
// Modes that never approve a tool call on their own: dontAsk turns prompts into denials.
const RESTRICTIVE_PERMISSION_MODES = new Set(['default', 'plan', 'dontAsk']);

// The scan runs on every side-effect tool call, so it is bounded. Anything too deep, too
// large or too many to scan cannot be shown to be safe and counts as granting.
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 2000;
const MAX_SETTINGS_BYTES = 1024 * 1024;
// Frontmatter sits at the top of the file. Most files close it within the first read; a
// frontmatter that is still open after the larger read counts as granting.
const FRONTMATTER_FIRST_READ_BYTES = 4 * 1024;
const FRONTMATTER_MAX_BYTES = 64 * 1024;
// Total bytes one check may read across all settings and definition files.
const MAX_TOTAL_READ_BYTES = 4 * 1024 * 1024;
// YAML parsing costs far more than reading, so the frontmatter actually parsed is bounded
// per block and per check.
const MAX_FRONTMATTER_PARSE_CHARS = 16 * 1024;
const MAX_TOTAL_PARSE_CHARS = 128 * 1024;
const MAX_MERGE_DEPTH = 8;

class ScanLimitError extends Error {}

function canonicalPath(target) {
  const resolved = path.resolve(target);
  let real;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    real = resolved;
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function isUserConfigDir(dir) {
  const candidates = [getClaudeDir(), process.env.CLAUDE_CONFIG_DIR].filter(Boolean);
  if (candidates.length === 0) return false;
  const target = canonicalPath(dir);
  return candidates.some(candidate => canonicalPath(candidate) === target);
}

function nonEmpty(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function grantsByMode(mode) {
  if (mode === undefined || mode === null || mode === '') return false;
  return !RESTRICTIVE_PERMISSION_MODES.has(mode);
}

/** A sandbox auto-allows sandboxed Bash unless it is switched off or told not to. */
function grantsBySandbox(sandbox) {
  if (!isPlainObject(sandbox)) return nonEmpty(sandbox);
  if (!nonEmpty(sandbox)) return false;
  return sandbox.enabled !== false && sandbox.autoAllowBashIfSandboxed !== false;
}

function hasPreToolUseHook(hooks) {
  if (!isPlainObject(hooks)) return nonEmpty(hooks);
  return nonEmpty(hooks.PreToolUse);
}

function definesAutoApprove(settings) {
  if (!isPlainObject(settings)) return true;

  const permissions = settings.permissions;
  if (permissions !== undefined && permissions !== null) {
    if (!isPlainObject(permissions)) return true;
    if (nonEmpty(permissions.allow)) return true;
    if (permissions.defaultMode !== undefined && grantsByMode(permissions.defaultMode)) return true;
  }
  if (nonEmpty(settings.allowedTools)) return true;
  if (settings.hooks !== undefined && hasPreToolUseHook(settings.hooks)) return true;
  if (grantsBySandbox(settings.sandbox)) return true;
  return false;
}

/** Whether an allowed-tools value names any tool: a comma-separated string or a list. */
function grantsTools(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string') return /[^\s,]/.test(value);
  if (Array.isArray(value)) return value.some(grantsTools);
  return nonEmpty(value);
}

// Keyed the way the CLI normalizes frontmatter keys: without '-' or '_', lowercased, so
// allowed-tools, allowed_tools and allowedTools are the same key.
const GRANTING_FRONTMATTER_KEYS = new Map([
  ['allowedtools', grantsTools],
  ['permissionmode', grantsByMode],
  ['hooks', hasPreToolUseHook],
]);

function normalizeKey(key) {
  return String(key).replace(/[-_]/g, '').toLowerCase();
}

function toJS(node, doc) {
  return YAML.isNode(node) ? node.toJS(doc, { maxAliasCount: 100 }) : node;
}

/**
 * Whether a YAML mapping node grants. Every pair is checked, so a duplicated key counts
 * with each of its values, and a merge key is checked on its own, so every merged value
 * counts whichever side a YAML parser lets win.
 */
function mappingGrants(node, doc, depth) {
  if (depth > MAX_MERGE_DEPTH) return true;
  const mapping = YAML.isAlias(node) ? node.resolve(doc) : node;
  if (!YAML.isMap(mapping)) return false;
  for (const pair of mapping.items) {
    const key = toJS(pair.key, doc);
    if (key === '<<') {
      const merged = YAML.isAlias(pair.value) ? pair.value.resolve(doc) : pair.value;
      const sources = YAML.isSeq(merged) ? merged.items : [merged];
      if (sources.some(source => mappingGrants(source, doc, depth + 1))) return true;
      continue;
    }
    const grants = GRANTING_FRONTMATTER_KEYS.get(normalizeKey(key));
    if (grants && grants(toJS(pair.value, doc))) return true;
  }
  return false;
}

/**
 * Whether YAML could read a granting key from this block. A key that is not spelled out
 * in the text needs an escape in a double-quoted scalar or a tag; aliases and merges
 * repeat text that is already there.
 */
function mayDefineGrantingKey(source) {
  const normalized = normalizeKey(source);
  for (const key of GRANTING_FRONTMATTER_KEYS.keys()) {
    if (normalized.includes(key)) return true;
  }
  return source.includes('\\') || /(?:^|[\s,[{])!/.test(source);
}

function frontmatterGrants(source, budget) {
  if (!mayDefineGrantingKey(source)) return false;
  if (source.length > MAX_FRONTMATTER_PARSE_CHARS) return true;
  budget.parseRemaining -= source.length;
  if (budget.parseRemaining < 0) return true;
  const doc = YAML.parseDocument(source, { merge: false, uniqueKeys: false });
  if (doc.errors.length > 0) return true;
  return mappingGrants(doc.contents, doc, 0);
}

const INCOMPLETE = Symbol('incomplete');

/**
 * The frontmatter blocks of a Markdown prefix, or INCOMPLETE when more of the file is needed.
 * The CLI ends the block at the first '---' after the opening line, even inside a line; the
 * block up to the first line that starts with '---' is checked as well, so a value that
 * contains '---' cannot hide the keys after it from either reading.
 */
function frontmatterBlocks(text, complete) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.length < 3 && !complete) return INCOMPLETE;
  if (!body.startsWith('---')) return [];

  const firstNewline = body.indexOf('\n');
  const lineClose = firstNewline < 0 ? -1 : body.indexOf('\n---', firstNewline);
  if (lineClose < 0 && !complete) return INCOMPLETE;

  // Without a closing '---' the CLI finds no frontmatter. Checking first also keeps the
  // regex linear: a long run of blank lines with no closing would make it backtrack.
  if (body.indexOf('---', 3) < 0) return [];
  const cliBlock = /^---\s*\n([\s\S]*?)---/.exec(body);
  if (!cliBlock) return [];
  const blocks = [cliBlock[1]];
  if (lineClose >= 0) {
    const lineBlock = body.slice(firstNewline + 1, lineClose);
    if (lineBlock !== cliBlock[1]) blocks.push(lineBlock);
  }
  return blocks;
}

function charge(budget, bytes) {
  budget.remaining -= bytes;
  if (budget.remaining < 0) throw new ScanLimitError('read budget exhausted');
}

function readFrom(fd, length, position, budget) {
  charge(budget, length);
  const buffer = Buffer.alloc(length);
  const bytes = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, bytes);
}

function definitionGrants(file, budget) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let head = readFrom(fd, Math.min(size, FRONTMATTER_FIRST_READ_BYTES), 0, budget);
    let blocks = frontmatterBlocks(head.toString('utf8'), head.length >= size);
    if (blocks === INCOMPLETE) {
      const rest = readFrom(fd, Math.min(size, FRONTMATTER_MAX_BYTES) - head.length, head.length, budget);
      head = Buffer.concat([head, rest]);
      blocks = frontmatterBlocks(head.toString('utf8'), head.length >= size);
    }
    if (blocks === INCOMPLETE) return true;
    return blocks.some(block => frontmatterGrants(block, budget));
  } finally {
    fs.closeSync(fd);
  }
}

function readSettings(file, budget) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_SETTINGS_BYTES) throw new ScanLimitError('settings file too large');
    return readFrom(fd, size, 0, budget).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether any Markdown definition under root can approve tools. Directory links are
 * followed once each (realpath), so a link cannot hide a definition or loop the scan.
 */
function anyDefinitionGrants(root, budget) {
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
        if (definitionGrants(target, budget)) return true;
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
 *   default mode, a PreToolUse hook or a sandbox that auto-allows Bash;
 * - an agent, skill or command under .claude/agents, .claude/skills or .claude/commands
 *   whose YAML frontmatter pre-approves tools (allowed-tools), sets a permissive
 *   permissionMode or declares a PreToolUse hook.
 *
 * All of these come with the repository, so a repository the user merely opened can ship
 * them. Anything that cannot be read, parsed or fully scanned counts as such a rule,
 * because it cannot be shown to be safe. The user's own configuration directory, also when
 * reached through a link, is never treated as project configuration.
 */
export function projectHasAutoApproveRules(cwd) {
  if (!cwd || typeof cwd !== 'string') return true;

  const claudeDir = path.join(cwd, '.claude');
  if (isUserConfigDir(claudeDir)) return false;

  const budget = { remaining: MAX_TOTAL_READ_BYTES, parseRemaining: MAX_TOTAL_PARSE_CHARS };
  for (const name of PROJECT_SETTINGS_FILES) {
    let raw;
    try {
      raw = readSettings(path.join(claudeDir, name), budget);
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

  return DEFINITION_DIRS.some(sub => anyDefinitionGrants(path.join(claudeDir, sub), budget));
}

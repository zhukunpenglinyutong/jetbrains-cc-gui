/**
 * Map OMP tool calls onto the Claude-shaped tool blocks the webview renders
 * with its specialized cards: `todo` feeds the todo panel, `edit` / `write`
 * become diff cards, `task` becomes subagent cards.
 *
 * OmpHistoryReader (Java) applies the same rules to restored sessions, so a
 * session looks the same live and after a reload.
 */

import { homedir } from 'os';
import { isAbsolute, resolve } from 'path';

const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
// `<marker><line number>|<text>`: marker is ' ' (context), '-' or '+'.
const DIFF_LINE = /^([ +-])\s*(\d{1,9})\|(.*)$/s;
const PATCH_HEADER = /^\[([^\]#\n]+)#[0-9A-Fa-f]{4}\]/m;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/;
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

/** Tools whose rendering needs the result, so the live stream holds the call back until it ends. */
const RESULT_DEPENDENT_TOOLS = new Set(['todo', 'edit']);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** Id of the k-th block synthesized from one OMP tool call. */
export function syntheticToolId(id, k) {
  return k === 0 ? id : `${id}#${k + 1}`;
}

export function absolutePath(path, cwd, home = homedir()) {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd || process.cwd(), path);
}

/**
 * Whether omp writes to `path` exactly as written (resolved against the session
 * directory, `~` and `~/` against home). Every other form is rewritten by omp
 * first (`@…`, `:…`, `~name`, `[path#TAG]`, `archive:member`, …), so where it
 * lands is only known from the result.
 */
export function isPlainFilePath(path, platform = process.platform) {
  if (typeof path !== 'string' || path === '' || path !== path.trim()) return false;
  if (CONTROL_CHARS.test(path) || UNICODE_SPACES.test(path) || URL_SCHEME.test(path)) return false;
  if (/^[@:[]/.test(path) || /^\/+$/.test(path)) return false;
  if (path.startsWith('~') && path !== '~' && !path.startsWith('~/') && !path.startsWith('~\\')) return false;
  if (platform === 'win32' && path.startsWith('/')) return false;
  return !(DRIVE_PREFIX.test(path) ? path.slice(2) : path).includes(':');
}

/**
 * Split OMP's numbered diff into its changed regions. Within a region the
 * context and `-` lines are a contiguous slice of the old file, the context
 * and `+` lines the matching slice of the new one. OMP prints hunks back to
 * back when it leaves out the unchanged lines between them, so a gap in the
 * line numbers, or any line that is not a diff line, ends the region.
 *
 * Context and `-` lines carry their line number in the old file, `+` lines
 * theirs in the new file.
 *
 * @param {string} diff
 * @returns {{ old_string: string, new_string: string }[]}
 */
export function parseNumberedDiff(diff) {
  const regions = [];
  let current = null;
  // Number the next old-file line (context, `-`) and the next new-file line (`+`) must have.
  let nextOld = null;
  let nextNew = null;
  for (const rawLine of String(diff ?? '').split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const match = DIFF_LINE.exec(line);
    const expected = match && (match[1] === '+' ? nextNew : nextOld);
    // omp leaves out unchanged lines between two changes without marking the gap.
    if (!match || (expected !== null && Number(match[2]) !== expected)) {
      current = null;
      nextOld = null;
      nextNew = null;
    }
    if (!match) continue;
    if (!current) {
      current = { before: [], after: [] };
      regions.push(current);
    }
    const [, marker, number, text] = match;
    if (marker !== '+') {
      current.before.push(text);
      nextOld = Number(number) + 1;
    }
    if (marker !== '-') current.after.push(text);
    if (marker === '+') nextNew = Number(number) + 1;
    else if (marker === ' ' && nextNew !== null) nextNew += 1;
  }
  return regions
    .map((region) => ({ old_string: region.before.join('\n'), new_string: region.after.join('\n') }))
    .filter((region) => region.old_string !== region.new_string);
}

function editedFiles(details) {
  if (Array.isArray(details.perFileResults) && details.perFileResults.length > 0) {
    return details.perFileResults.filter(
      (file) => file && typeof file.path === 'string' && typeof file.diff === 'string',
    );
  }
  return typeof details.path === 'string' && typeof details.diff === 'string' ? [details] : [];
}

function todoItems(phases) {
  const todos = [];
  for (const phase of phases) {
    for (const task of Array.isArray(phase?.tasks) ? phase.tasks : []) {
      if (!task || typeof task.content !== 'string' || task.status === 'abandoned') continue;
      todos.push({
        content: task.content,
        // The todo panel knows pending / in_progress / completed only.
        status: task.status === 'blocked' ? 'pending' : task.status,
        activeForm: task.content,
      });
    }
  }
  return todos;
}

function editFallbackInput(input) {
  const path = typeof input.path === 'string'
    ? input.path
    : PATCH_HEADER.exec(typeof input.input === 'string' ? input.input : '')?.[1];
  return path && typeof input.file_path !== 'string' ? { ...input, file_path: path } : input;
}

/**
 * The complete mapping of one OMP tool call.
 *
 * @param {{ id: string, name: string, args?: object, cwd?: string, home?: string }} call
 * @param {{ text?: string, details?: object, isError?: boolean }|null} [result] null while the call is running
 * @returns {{
 *   uses: { id: string, name: string, input: object }[],
 *   results: { toolUseId: string, content: string, isError: boolean }[],
 * }} `results` is empty without a result
 */
export function mapCompletedTool(call, result = null) {
  const { id, name, cwd, home } = call;
  const input = asObject(call.args);
  const details = asObject(result?.details);
  const text = typeof result?.text === 'string' ? result.text : '';
  const isError = Boolean(result?.isError);
  const succeeded = result !== null && !isError;

  // One result per block: the first carries the tool's text, the rest are empty.
  const mapped = (uses) => ({
    uses,
    results: result === null
      ? []
      : uses.map((use, index) => ({ toolUseId: use.id, content: index === 0 ? text : '', isError })),
  });

  if (name === 'todo' && succeeded && Array.isArray(details.phases)) {
    return mapped([{ id, name: 'TodoWrite', input: { todos: todoItems(details.phases) } }]);
  }

  if (name === 'edit' && succeeded) {
    const uses = [];
    for (const file of editedFiles(details)) {
      for (const region of parseNumberedDiff(file.diff)) {
        uses.push({
          id: syntheticToolId(id, uses.length),
          name: 'Edit',
          input: { file_path: file.path, ...region },
        });
      }
    }
    if (uses.length > 0) return mapped(uses);
  }

  if (name === 'write' && typeof input.path === 'string' && !URL_SCHEME.test(input.path)
    && typeof input.content === 'string') {
    // omp rewrites some paths before writing; only a plain one is known without the result.
    const filePath = typeof details.resolvedPath === 'string'
      ? details.resolvedPath
      : isPlainFilePath(input.path) ? absolutePath(input.path, cwd, home) : undefined;
    if (filePath !== undefined) {
      return mapped([{ id, name: 'Write', input: { file_path: filePath, content: input.content } }]);
    }
  }

  if (name === 'task' && Array.isArray(input.tasks) && input.tasks.length > 0) {
    return mapped(input.tasks.map((entry, index) => {
      const task = asObject(entry);
      return {
        id: syntheticToolId(id, index),
        name: 'Task',
        input: {
          description: firstNonEmptyString(task.name, task.id, task.description) ?? `Task ${index + 1}`,
          prompt: firstNonEmptyString(task.task, task.assignment, task.prompt, task.description) ?? '',
          subagent_type: firstNonEmptyString(task.agent, input.agent) ?? 'task',
        },
      };
    }));
  }

  return mapped([{ id, name, input: name === 'edit' ? editFallbackInput(input) : input }]);
}

/**
 * Blocks to show as soon as a call starts, or null when the call must wait for
 * its result (see RESULT_DEPENDENT_TOOLS, and `write` to a path omp rewrites).
 */
export function mapStartedTool(call) {
  if (RESULT_DEPENDENT_TOOLS.has(call.name)) return null;
  const path = call.args?.path;
  if (call.name === 'write' && typeof path === 'string' && !URL_SCHEME.test(path) && !isPlainFilePath(path)) {
    return null;
  }
  return mapCompletedTool(call).uses;
}

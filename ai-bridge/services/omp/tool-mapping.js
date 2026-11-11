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
const DIFF_LINE = /^([ +-])\s*\d+\|(.*)$/s;
const PATCH_HEADER = /^\[([^\]#\n]+)#[0-9A-Fa-f]{4}\]/m;

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
 * Split OMP's numbered diff into its changed regions. An empty line separates
 * regions that are not adjacent in the file; within a region the context and
 * `-` lines are a contiguous slice of the old file, the context and `+` lines
 * the matching slice of the new one. Any line that is not a diff line ends the
 * region, so a region never joins lines that were apart.
 *
 * @param {string} diff
 * @returns {{ old_string: string, new_string: string }[]}
 */
export function parseNumberedDiff(diff) {
  const regions = [];
  let current = null;
  for (const rawLine of String(diff ?? '').split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const match = DIFF_LINE.exec(line);
    if (!match) {
      current = null;
      continue;
    }
    if (!current) {
      current = { before: [], after: [] };
      regions.push(current);
    }
    const [, marker, text] = match;
    if (marker !== '+') current.before.push(text);
    if (marker !== '-') current.after.push(text);
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
    const filePath = typeof details.resolvedPath === 'string'
      ? details.resolvedPath
      : absolutePath(input.path, cwd, home);
    return mapped([{ id, name: 'Write', input: { file_path: filePath, content: input.content } }]);
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
 * its result (see RESULT_DEPENDENT_TOOLS).
 */
export function mapStartedTool(call) {
  return RESULT_DEPENDENT_TOOLS.has(call.name) ? null : mapCompletedTool(call).uses;
}

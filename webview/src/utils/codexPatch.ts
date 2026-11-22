import type { ToolInput, ToolResultBlock } from '../types';
import type { DiffResult } from '../components/toolBlocks/EditDiffView';

export interface PatchFile {
  path: string;
  movePath?: string;
  kind: 'add' | 'delete' | 'update';
  diff: DiffResult;
  diffText?: string;
  content?: string;
  fullContentKnown?: boolean;
}

/** A wrapper preview remains neutral until an individual outcome is known. */
export function readPatchOutcome(input?: ToolInput, result?: ToolResultBlock | null, denied = false) {
  const status = input?.status;
  const isUnknown = status === 'unknown';
  const isError = denied || result?.is_error === true || status === 'failed' || status === 'declined' || status === 'interrupted';
  const isCompleted = isError || result != null || status === 'completed';
  return { isUnknown, isError, isCompleted };
}

function readDiff(lines: string[], unified: boolean): DiffResult {
  const diff: DiffResult = { lines: [], additions: 0, deletions: 0 };
  const hasHeaders = lines.some((line, index) => line.startsWith('diff --git ')
    || line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ '));
  let inHunk = !unified || !hasHeaders;
  for (const line of lines) {
    if (unified && line.startsWith('diff --git ')) {
      // A second file's header must not be counted as hunk content.
      inHunk = false;
      continue;
    }
    if (unified && /^(?:index |--- |\+\+\+ )/.test(line) && !inHunk) continue;
    if (line.startsWith('@@')) inHunk = true;
    if (line.startsWith('+')) {
      diff.lines.push({ type: 'added', content: line.slice(1) });
      diff.additions++;
    } else if (line.startsWith('-')) {
      diff.lines.push({ type: 'deleted', content: line.slice(1) });
      diff.deletions++;
    } else if (line.startsWith(' ')) {
      diff.lines.push({ type: 'unchanged', content: line.slice(1) });
    } else if (line !== '*** End of File' && line !== '\\ No newline at end of file') {
      diff.lines.push({ type: 'unchanged', content: line });
    }
  }
  return diff;
}

/** Native add/delete bodies are literal text, including prefixes and lone carriage returns. */
function readFileContent(content: string, kind: 'add' | 'delete'): DiffResult {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return {
    lines: lines.map(line => ({ type: kind === 'add' ? 'added' : 'deleted', content: line })),
    additions: kind === 'add' ? lines.length : 0,
    deletions: kind === 'delete' ? lines.length : 0,
  };
}

/** Only add/delete bodies provide whole files; update hunks remain previews. */
export function readPatchFiles(input: ToolInput | undefined): PatchFile[] {
  if (!input) return [];
  if (Array.isArray(input.changes)) {
    if (!input.changes.every((value) => {
      if (!value || typeof value !== 'object') return false;
      const change = value as Record<string, unknown>;
      const kind = typeof change.kind === 'object' && change.kind
        ? (change.kind as Record<string, unknown>).type : change.kind ?? change.type;
      return typeof change.path === 'string' && Boolean(change.path.trim())
        && (kind == null || ['add', 'delete', 'update'].includes(String(kind)));
    })) return [];
    return input.changes.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const change = value as Record<string, unknown>;
      if (typeof change.path !== 'string' || !change.path.trim()) return [];
      const kind = typeof change.kind === 'object' && change.kind
        ? change.kind as Record<string, unknown> : { type: change.kind ?? change.type };
      const fileKind = kind.type === 'add' ? 'add' : kind.type === 'delete' ? 'delete' : 'update';
      const movePath = kind.movePath ?? kind.move_path ?? change.movePath ?? change.move_path ?? change.newPath;
      const suppliedDiff = change.diff ?? change.unified_diff;
      const diff = typeof suppliedDiff === 'string' ? suppliedDiff.replace(/\r\n/g, '\n') : '';
      // Legacy records supply explicit content; native add/delete puts that same body in diff.
      const content = typeof change.content === 'string' ? change.content
        : fileKind !== 'update' && typeof change.diff === 'string' ? change.diff : undefined;
      return [{ path: change.path, kind: fileKind,
        ...(typeof movePath === 'string' ? { movePath } : {}),
        ...(content !== undefined ? { content } : {}),
        fullContentKnown: content !== undefined || typeof suppliedDiff === 'string',
        diffText: diff, diff: fileKind !== 'update' && content !== undefined
          ? readFileContent(content, fileKind) : readDiff(diff ? diff.split('\n') : [], true) }];
    });
  }
  const source = typeof input.patch === 'string' ? input.patch : typeof input.input === 'string' ? input.input : '';
  const patch = source.replace(/\r\n/g, '\n').trim();
  if (!patch.startsWith('*** Begin Patch\n') || !patch.endsWith('*** End Patch')) return [];
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  let body: string[] = [];
  const flush = () => { if (current) { current.diffText = body.join('\n'); current.diff = readDiff(body, false); } body = []; };
  for (const line of patch.split('\n').slice(1, -1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      if (!header[2].trim()) return [];
      flush();
      current = { path: header[2].trim(), kind: header[1] === 'Add' ? 'add' : header[1] === 'Delete' ? 'delete' : 'update',
        fullContentKnown: header[1] !== 'Delete',
        diff: { lines: [], additions: 0, deletions: 0 } };
      files.push(current);
    } else if (line.startsWith('*** Move to: ') && current) {
      current.movePath = line.slice('*** Move to: '.length).trim();
      if (!current.movePath) return [];
    } else if (current) body.push(line);
    else if (line.trim()) return [];
  }
  flush();
  return files;
}

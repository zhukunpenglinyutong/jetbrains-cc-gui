/** File-level projection of one `git diff` text, for the workspace diff dialog. */

export type WorkspaceDiffFileKind = 'add' | 'delete' | 'rename' | 'modify';

export interface WorkspaceDiffFile {
  path: string;
  kind: WorkspaceDiffFileKind;
  binary: boolean;
}

const DIFF_GIT_RE = /^diff --git ("(?:\\.|[^"\\])*"|a\/.+?) ("(?:\\.|[^"\\])*"|b\/.+)$/;
const GIT_PATH_ESCAPES: Record<string, number> = {
  a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92,
};

/** Git quotes UTF-8 bytes, so decoding octets separately would corrupt non-ASCII paths. */
function decodeGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const quoted = path.slice(1, -1);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let cursor = 0;
  for (const match of quoted.matchAll(/\\([0-7]{1,3}|[abfnrtv"\\])/g)) {
    bytes.push(...encoder.encode(quoted.slice(cursor, match.index)));
    bytes.push(/^[0-7]/.test(match[1]) ? Number.parseInt(match[1], 8) : GIT_PATH_ESCAPES[match[1]]);
    cursor = match.index + match[0].length;
  }
  bytes.push(...encoder.encode(quoted.slice(cursor)));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Extracts changed-file identities from a unified diff. Hunk bodies are
 * skipped after the first @@ so removed lines that themselves start with
 * "--- "/"+++ " cannot be mistaken for file headers.
 */
export function parseWorkspaceDiffFiles(diffText: string): WorkspaceDiffFile[] {
  const files: WorkspaceDiffFile[] = [];
  if (typeof diffText !== 'string' || !diffText) return files;
  let current: WorkspaceDiffFile | null = null;
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = DIFF_GIT_RE.exec(line);
      current = { path: match ? decodeGitPath(match[2]).replace(/^b\//, '')
        : line.slice('diff --git '.length).trim(), kind: 'modify', binary: false };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (inHunk) continue;
    if (line.startsWith('new file mode')) {
      current.kind = 'add';
    } else if (line.startsWith('deleted file mode')) {
      current.kind = 'delete';
    } else if (line.startsWith('rename to ')) {
      current.kind = 'rename';
      current.path = decodeGitPath(line.slice('rename to '.length).trim());
    } else if (line.startsWith('+++ ')) {
      const target = decodeGitPath(line.slice(4).trim());
      if (target === '/dev/null') {
        current.kind = 'delete';
      } else {
        current.path = target.replace(/^b\//, '');
      }
    } else if (line.startsWith('GIT binary patch')) {
      current.binary = true;
    }
  }
  return files;
}

/** Result payload sent by the Java CodexWorkspaceDiffHandler. */
export interface CodexWorkspaceDiffResult {
  cwd?: string;
  repository?: boolean;
  root?: string;
  readTime?: number;
  staged?: string;
  unstaged?: string;
  untracked?: unknown;
  error?: string;
  truncated?: boolean;
  sessionId?: string | null;
}

export function parseWorkspaceDiffSnapshot(result: CodexWorkspaceDiffResult): {
  staged: WorkspaceDiffFile[];
  unstaged: WorkspaceDiffFile[];
  untracked: string[];
} {
  const untracked = Array.isArray(result.untracked)
    ? result.untracked.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    staged: parseWorkspaceDiffFiles(result.staged ?? ''),
    unstaged: parseWorkspaceDiffFiles(result.unstaged ?? ''),
    untracked,
  };
}

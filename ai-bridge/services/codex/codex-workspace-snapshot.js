import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git', '.idea', '.gradle', '.m2', '.m2_repo', '.next', '.nuxt', '.turbo', '.cache',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', '__pycache__', 'build', 'coverage',
  'dist', 'env', 'logs', 'node_modules', 'out', 'target', 'temp', 'tmp', 'venv'
]);

const IGNORED_FILE_NAMES = new Set(['.DS_Store']);

function normalizeRoot(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return '';
  return resolve(cwd);
}

function isPathWithinRoot(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!!relativePath && !relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

function isIgnoredDirectory(name) {
  return IGNORED_DIRECTORY_NAMES.has(name);
}

function isIgnoredFile(name) {
  return IGNORED_FILE_NAMES.has(name);
}

function isLikelyBinary(buffer) {
  const limit = Math.min(buffer.length, 8192);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function sha256(content) {
  return createHash('sha256').update(typeof content === 'string' ? content : '').digest('hex');
}

async function readSnapshotFile(filePath, fileStat, limits) {
  if (!fileStat.isFile()) return null;
  if (fileStat.size > limits.maxFileBytes) return null;
  const buffer = await readFile(filePath);
  if (isLikelyBinary(buffer)) return null;
  return {
    path: resolve(filePath),
    existed: true,
    binary: false,
    content: buffer.toString('utf8'),
    length: fileStat.size,
    modifiedAtMillis: fileStat.mtimeMs,
  };
}

export async function captureWorkspaceSnapshot(cwd, options = {}) {
  const root = normalizeRoot(cwd);
  if (!root) return null;

  const limits = {
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };

  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return null;
  } catch {
    return null;
  }

  const files = new Map();
  const directories = [root];
  let totalBytes = 0;
  let truncated = false;

  while (directories.length > 0) {
    const directory = directories.shift();
    if (!directory) continue;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      if (!isPathWithinRoot(root, absolutePath)) continue;
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (!isIgnoredDirectory(entry.name)) {
          if (!isPathWithinRoot(root, absolutePath)) continue;
          directories.push(absolutePath);
        }
        continue;
      }

      if (!entry.isFile() || isIgnoredFile(entry.name)) continue;
      if (files.size >= limits.maxFiles || totalBytes >= limits.maxTotalBytes) {
        truncated = true;
        continue;
      }

      let fileStat;
      try {
        fileStat = await stat(absolutePath);
      } catch {
        continue;
      }
      if (totalBytes + fileStat.size > limits.maxTotalBytes) {
        truncated = true;
        continue;
      }

      try {
        const snapshot = await readSnapshotFile(absolutePath, fileStat, limits);
        if (!snapshot) continue;
        files.set(snapshot.path, snapshot);
        totalBytes += snapshot.length;
      } catch {
        // File may disappear or become unreadable while Codex is running.
      }
    }
  }

  return { root, files, totalBytes, truncated };
}

function countLines(content) {
  if (!content) return 1;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') lines += 1;
  }
  return lines;
}

function splitLinesPreserveEndings(content) {
  if (!content) return [];
  const lines = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      lines.push(content.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < content.length) {
    lines.push(content.slice(start));
  }
  return lines;
}

function joinLines(lines, fromInclusive, toExclusive) {
  let result = '';
  for (let index = fromInclusive; index < toExclusive; index += 1) {
    result += lines[index];
  }
  return result;
}

function singleHunk(beforeLines, afterLines, oldChangeStart, oldChangeEnd, newChangeStart, newChangeEnd) {
  const contextLines = 2;
  return {
    oldFrom: Math.max(0, oldChangeStart - contextLines),
    oldTo: Math.min(beforeLines.length, oldChangeEnd + contextLines),
    newFrom: Math.max(0, newChangeStart - contextLines),
    newTo: Math.min(afterLines.length, newChangeEnd + contextLines),
  };
}

function buildHunkRanges(beforeLines, afterLines) {
  const beforeSize = beforeLines.length;
  const afterSize = afterLines.length;
  if (beforeSize * afterSize > 200000) {
    return [singleHunk(beforeLines, afterLines, 0, beforeSize, 0, afterSize)];
  }

  const lcs = Array.from({ length: beforeSize + 1 }, () => Array(afterSize + 1).fill(0));
  for (let oldIndex = beforeSize - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = afterSize - 1; newIndex >= 0; newIndex -= 1) {
      if (beforeLines[oldIndex] === afterLines[newIndex]) {
        lcs[oldIndex][newIndex] = lcs[oldIndex + 1][newIndex + 1] + 1;
      } else {
        lcs[oldIndex][newIndex] = Math.max(lcs[oldIndex + 1][newIndex], lcs[oldIndex][newIndex + 1]);
      }
    }
  }

  const rawRanges = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldStart = -1;
  let newStart = -1;

  while (oldIndex < beforeSize || newIndex < afterSize) {
    if (oldIndex < beforeSize && newIndex < afterSize && beforeLines[oldIndex] === afterLines[newIndex]) {
      if (oldStart >= 0) {
        rawRanges.push({ oldStart, oldEnd: oldIndex, newStart, newEnd: newIndex });
        oldStart = -1;
        newStart = -1;
      }
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (oldStart < 0) {
      oldStart = oldIndex;
      newStart = newIndex;
    }

    if (newIndex < afterSize && (oldIndex === beforeSize || lcs[oldIndex][newIndex + 1] >= lcs[oldIndex + 1][newIndex])) {
      newIndex += 1;
    } else if (oldIndex < beforeSize) {
      oldIndex += 1;
    }
  }

  if (oldStart >= 0) {
    rawRanges.push({ oldStart, oldEnd: oldIndex, newStart, newEnd: newIndex });
  }

  const hunks = [];
  for (const raw of rawRanges) {
    const next = singleHunk(beforeLines, afterLines, raw.oldStart, raw.oldEnd, raw.newStart, raw.newEnd);
    const previous = hunks[hunks.length - 1];
    if (previous && (next.oldFrom <= previous.oldTo || next.newFrom <= previous.newTo)) {
      hunks[hunks.length - 1] = {
        oldFrom: previous.oldFrom,
        oldTo: Math.max(previous.oldTo, next.oldTo),
        newFrom: previous.newFrom,
        newTo: Math.max(previous.newTo, next.newTo),
      };
    } else {
      hunks.push(next);
    }
  }
  return hunks;
}

export function buildEditOperationsFromSnapshots(filePath, existedBefore, beforeContent, afterContent) {
  const before = typeof beforeContent === 'string' ? beforeContent : '';
  const after = typeof afterContent === 'string' ? afterContent : '';
  if (before.includes('\0') || after.includes('\0')) return [];

  if (!existedBefore) {
    if (!after) return [];
    return [{
      toolName: 'write',
      filePath,
      oldString: '',
      newString: after,
      replaceAll: false,
      startLine: 1,
      endLine: Math.max(1, countLines(after)),
      safeToRollback: true,
      existedBefore: false,
      expectedAfterContentHash: sha256(after),
    }];
  }

  if (before === after) return [];

  const beforeLines = splitLinesPreserveEndings(before);
  const afterLines = splitLinesPreserveEndings(after);
  const hunks = buildHunkRanges(beforeLines, afterLines);
  const operations = [];

  for (const hunk of hunks) {
    const oldString = joinLines(beforeLines, hunk.oldFrom, hunk.oldTo);
    const newString = joinLines(afterLines, hunk.newFrom, hunk.newTo);
    if (oldString === newString) continue;
    const startLine = hunk.newFrom + 1;
    operations.push({
      toolName: 'edit',
      filePath,
      oldString,
      newString,
      replaceAll: false,
      startLine,
      endLine: Math.max(startLine, hunk.newTo),
      safeToRollback: newString.length > 0,
      existedBefore: true,
      expectedAfterContentHash: sha256(after),
    });
  }

  return operations;
}

export function diffWorkspaceSnapshots(beforeSnapshot, afterSnapshot) {
  if (!beforeSnapshot || !afterSnapshot) return [];

  const paths = new Set([
    ...beforeSnapshot.files.keys(),
    ...afterSnapshot.files.keys(),
  ]);
  const operations = [];

  for (const filePath of Array.from(paths).sort((left, right) => left.localeCompare(right))) {
    const before = beforeSnapshot.files.get(filePath);
    const after = afterSnapshot.files.get(filePath);

    if (!before && after) {
      operations.push(...buildEditOperationsFromSnapshots(filePath, false, '', after.content));
      continue;
    }

    if (before && !after) {
      if (!before.binary && before.existed) {
        operations.push({
          toolName: 'edit',
          filePath,
          oldString: before.content,
          newString: '',
          replaceAll: false,
          startLine: 1,
          endLine: 1,
          safeToRollback: false,
          existedBefore: true,
          expectedAfterContentHash: '',
        });
      }
      continue;
    }

    if (!before || !after || before.binary || after.binary) continue;
    if (before.content === after.content) continue;
    operations.push(...buildEditOperationsFromSnapshots(filePath, true, before.content, after.content));
  }

  return operations;
}

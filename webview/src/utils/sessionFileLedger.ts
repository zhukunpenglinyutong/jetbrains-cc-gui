/**
 * Session file-change ledger: net baseline → current per file (not sum of ops).
 *
 * Rules:
 * - First successful edit of a file locks a reconstructed "before" baseline
 * - Later edits only advance "current"
 * - +N/-M = diff(baseline, current) once per file
 * - multiAgent when ≥2 distinct agents touched the file
 * - Rebuildable from message tool ops so history restore does not drop stats
 */

import type { EditOperation, FileChangeStatus, FileChangeSummary } from '../types/fileChanges';
import { getFileName } from './helpers';
import { normalizeToolName } from './toolConstants';

/** Write-style tools that replace entire file content */
const WRITE_TOOL_NAMES = new Set(['write', 'write_file', 'create_file', 'write_to_file']);

export interface LedgerOp {
  filePath: string;
  toolName: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  /** Stable agent key; main conversation uses "main" */
  agentId: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface SessionFileLedgerEntry {
  filePath: string;
  fileName: string;
  status: FileChangeStatus;
  baseline: string;
  current: string;
  additions: number;
  deletions: number;
  multiAgent: boolean;
  agentIds: string[];
  operations: EditOperation[];
  lineStart?: number;
  lineEnd?: number;
}

/**
 * Apply a single search-replace (or reverse) to content.
 * Returns original content if oldString is not found (non-empty).
 */
export function applySearchReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (oldString === '') {
    // Empty old: treat as full replace / write-style inject
    return newString;
  }
  if (replaceAll) {
    if (!content.includes(oldString)) {
      return content;
    }
    return content.split(oldString).join(newString);
  }
  const index = content.indexOf(oldString);
  if (index === -1) {
    return content;
  }
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}

function isWriteTool(toolName: string): boolean {
  return WRITE_TOOL_NAMES.has(normalizeToolName(toolName));
}

export interface ReconstructResult {
  current: string;
  baseline: string;
  /** False when some non-overlapping Edit snippets could not be applied in sequence */
  fullyApplied: boolean;
}

/**
 * Forward-apply ops, then reverse to baseline.
 * When sequential apply cannot place every edit (typical non-overlapping MultiEdit
 * snippets without full file text), fullyApplied=false so callers can fall back
 * to summed per-op stats instead of a wrong partial net.
 */
export function reconstructBaselineAndCurrent(ops: LedgerOp[]): ReconstructResult {
  if (ops.length === 0) {
    return { current: '', baseline: '', fullyApplied: true };
  }

  let content: string | null = null;
  let fullyApplied = true;

  for (const op of ops) {
    if (isWriteTool(op.toolName)) {
      content = op.newString;
      continue;
    }

    if (content === null) {
      content = op.oldString;
      content = applySearchReplace(content, op.oldString, op.newString, op.replaceAll === true);
      continue;
    }

    if (op.oldString !== '' && !content.includes(op.oldString)) {
      fullyApplied = false;
      continue;
    }
    const next = applySearchReplace(content, op.oldString, op.newString, op.replaceAll === true);
    if (next === content && op.oldString !== op.newString && op.oldString !== '') {
      fullyApplied = false;
    } else {
      content = next;
    }
  }

  const current = content ?? '';
  let baseline = current;
  if (fullyApplied) {
    for (let i = ops.length - 1; i >= 0; i -= 1) {
      const op = ops[i];
      if (isWriteTool(op.toolName)) {
        baseline = op.oldString;
        continue;
      }
      baseline = applySearchReplace(baseline, op.newString, op.oldString, op.replaceAll === true);
    }
  }

  return { current, baseline, fullyApplied };
}

/** @deprecated use reconstructBaselineAndCurrent */
export function reconstructCurrent(ops: LedgerOp[]): string {
  return reconstructBaselineAndCurrent(ops).current;
}

/** @deprecated use reconstructBaselineAndCurrent */
export function reconstructBaseline(ops: LedgerOp[], current: string): string {
  return reconstructBaselineAndCurrent(ops).baseline || current;
}

export interface DiffLineStats {
  additions: number;
  deletions: number;
}

/**
 * Line-level LCS / multiset stats (same rules as StatusPanel historically).
 * Kept here so ledger tests do not depend on React hook module cache.
 */
const LCS_MAX_LINES = 100;

function multisetDiff(oldLines: string[], newLines: string[]): DiffLineStats {
  const remaining = new Map<string, number>();
  for (const line of oldLines) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  let common = 0;
  for (const line of newLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      common += 1;
      remaining.set(line, count - 1);
    }
  }
  return {
    additions: newLines.length - common,
    deletions: oldLines.length - common,
  };
}

function lcsDiff(oldLines: string[], newLines: string[]): DiffLineStats {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  let additions = 0;
  let deletions = 0;
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      additions += 1;
      j -= 1;
    } else {
      deletions += 1;
      i -= 1;
    }
  }
  return { additions, deletions };
}

export function diffLineStats(oldString: string, newString: string): DiffLineStats {
  const oldLines = oldString ? oldString.split('\n') : [];
  const newLines = newString ? newString.split('\n') : [];
  if (oldLines.length === 0 && newLines.length === 0) {
    return { additions: 0, deletions: 0 };
  }
  if (oldLines.length === 0) {
    return { additions: newLines.length, deletions: 0 };
  }
  if (newLines.length === 0) {
    return { additions: 0, deletions: oldLines.length };
  }
  if (oldLines.length > LCS_MAX_LINES || newLines.length > LCS_MAX_LINES) {
    return multisetDiff(oldLines, newLines);
  }
  return lcsDiff(oldLines, newLines);
}

function determineStatus(ops: LedgerOp[], baseline: string): FileChangeStatus {
  if (ops.length === 0) {
    return 'M';
  }
  const first = ops[0];
  if (isWriteTool(first.toolName)) {
    return 'A';
  }
  if (baseline === '' && first.newString !== '') {
    return 'A';
  }
  return 'M';
}

/**
 * Build per-file ledger entries from ordered successful ops (all agents mixed by time).
 */
export function buildSessionFileLedger(ops: LedgerOp[]): SessionFileLedgerEntry[] {
  const byPath = new Map<string, LedgerOp[]>();

  for (const op of ops) {
    if (!op.filePath) continue;
    if (op.oldString === '' && op.newString === '') continue;
    const list = byPath.get(op.filePath) ?? [];
    list.push(op);
    byPath.set(op.filePath, list);
  }

  const entries: SessionFileLedgerEntry[] = [];

  byPath.forEach((fileOps, filePath) => {
    const operations: EditOperation[] = fileOps.map((o) => {
      const perOp = diffLineStats(o.oldString, o.newString);
      return {
        toolName: o.toolName,
        oldString: o.oldString,
        newString: o.newString,
        additions: perOp.additions,
        deletions: perOp.deletions,
        replaceAll: o.replaceAll,
        lineStart: o.lineStart,
        lineEnd: o.lineEnd,
      };
    });

    const reconstructed = reconstructBaselineAndCurrent(fileOps);
    let additions: number;
    let deletions: number;
    let baseline = reconstructed.baseline;
    let current = reconstructed.current;

    if (reconstructed.fullyApplied) {
      const net = diffLineStats(baseline, current);
      additions = net.additions;
      deletions = net.deletions;
    } else {
      // Non-overlapping MultiEdit snippets without full file: sum per-op (legacy-safe)
      additions = operations.reduce((sum, op) => sum + (op.additions || 0), 0);
      deletions = operations.reduce((sum, op) => sum + (op.deletions || 0), 0);
      baseline = '';
      current = '';
    }

    const agentIds = [...new Set(fileOps.map((o) => o.agentId || 'main').filter(Boolean))];
    const multiAgent = agentIds.length >= 2;
    const status = determineStatus(fileOps, reconstructed.fullyApplied ? baseline : fileOps[0]?.oldString ?? '');
    const firstLine = fileOps.find((o) => typeof o.lineStart === 'number');

    entries.push({
      filePath,
      fileName: getFileName(filePath) || filePath || 'unknown',
      status,
      baseline,
      current,
      additions,
      deletions,
      multiAgent,
      agentIds,
      operations,
      lineStart: firstLine?.lineStart,
      lineEnd: firstLine?.lineEnd,
    });
  });

  entries.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === 'A' ? -1 : 1;
    }
    return a.filePath.localeCompare(b.filePath);
  });

  return entries;
}

export function ledgerEntriesToSummaries(entries: SessionFileLedgerEntry[]): FileChangeSummary[] {
  return entries.map((e) => ({
    filePath: e.filePath,
    fileName: e.fileName,
    status: e.status,
    additions: e.additions,
    deletions: e.deletions,
    multiAgent: e.multiAgent,
    agentIds: e.agentIds,
    lineStart: e.lineStart,
    lineEnd: e.lineEnd,
    operations: e.operations,
  }));
}

/** localStorage key for optional lightweight meta (agent marks / generation) */
export function ledgerStorageKey(sessionId: string): string {
  return `session-file-ledger-meta-${sessionId}`;
}

export interface LedgerPersistMeta {
  /** Keep-all base message index when this meta was saved */
  baseMessageIndex: number;
  /** Paths marked multi-agent (survives rebuild when ops still present) */
  multiAgentPaths: string[];
  updatedAt: number;
}

export function saveLedgerMeta(sessionId: string, meta: LedgerPersistMeta): void {
  try {
    localStorage.setItem(ledgerStorageKey(sessionId), JSON.stringify(meta));
  } catch {
    // quota / private mode
  }
}

export function loadLedgerMeta(sessionId: string): LedgerPersistMeta | null {
  try {
    const raw = localStorage.getItem(ledgerStorageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LedgerPersistMeta;
    if (typeof parsed?.baseMessageIndex !== 'number') return null;
    if (!Array.isArray(parsed.multiAgentPaths)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearLedgerMeta(sessionId: string): void {
  try {
    localStorage.removeItem(ledgerStorageKey(sessionId));
  } catch {
    // ignore
  }
}

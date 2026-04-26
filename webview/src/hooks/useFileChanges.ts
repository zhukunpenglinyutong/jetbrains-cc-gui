import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import type { FileChangeSummary, EditOperation, FileChangeStatus } from '../types/fileChanges';
import { getFileName } from '../utils/helpers';
import { FILE_MODIFY_TOOL_NAMES, isToolName, normalizeToolName } from '../utils/toolConstants';
import { normalizeToolInput } from '../utils/toolInputNormalization';
import { getToolLineInfo } from '../utils/toolPresentation';
import { getFileChangeStatusFromOperations } from '../utils/fileChangeProcessing';


const SOURCE_PRIORITY: Record<string, number> = {
  codex_session_patch: 3,
  main: 2,
  subagent: 1,
};

function getOperationIdentityKey(operation: EditOperation): string | undefined {
  if (operation.operationId) {
    return `op:${operation.operationId}`;
  }
  if (operation.toolUseId) {
    return `tool:${operation.toolUseId}`;
  }
  return undefined;
}

function getOperationDedupeKey(filePath: string, operation: EditOperation): string {
  return [
    filePath,
    operation.toolName,
    operation.oldString,
    operation.newString,
    operation.lineStart ?? '',
    operation.lineEnd ?? '',
    operation.existedBefore ?? '',
  ].join('\u0000');
}

function normalizedSource(operation: EditOperation): string {
  return operation.source ?? 'main';
}

function shouldDedupeOperation(existing: EditOperation, next: EditOperation, filePath: string): boolean {
  const existingIdentity = getOperationIdentityKey(existing);
  const nextIdentity = getOperationIdentityKey(next);
  if (existingIdentity && nextIdentity && existingIdentity === nextIdentity) {
    return true;
  }
  if (normalizedSource(existing) === normalizedSource(next)) {
    return false;
  }
  return getOperationDedupeKey(filePath, existing) === getOperationDedupeKey(filePath, next);
}

function shouldReplaceOperation(existing: EditOperation, next: EditOperation): boolean {
  const existingPriority = existing.source ? SOURCE_PRIORITY[existing.source] ?? 0 : 0;
  const nextPriority = next.source ? SOURCE_PRIORITY[next.source] ?? 0 : 0;
  return nextPriority > existingPriority;
}

function addDedupedOperation(operations: EditOperation[], filePath: string, operation: EditOperation): EditOperation[] {
  const existingIndex = operations.findIndex((existing) => shouldDedupeOperation(existing, operation, filePath));
  if (existingIndex < 0) {
    return [...operations, operation];
  }
  if (!shouldReplaceOperation(operations[existingIndex], operation)) {
    return operations;
  }
  const next = [...operations];
  next[existingIndex] = operation;
  return next;
}

/**
 * Maximum lines to use LCS algorithm.
 * LCS has O(n*m) time and space complexity.
 * For files > 100 lines, we use a faster estimation to prevent UI freezes.
 * Threshold chosen based on: 100*100 = 10,000 operations, acceptable for UI thread.
 */
const LCS_MAX_LINES = 100;

/** Cache for diff calculations to avoid redundant computations */
const diffCache = new Map<string, { additions: number; deletions: number }>();
const DIFF_CACHE_MAX_SIZE = 100;

/**
 * Generate cache key from strings (using hash-like approach for large strings)
 */
function getDiffCacheKey(oldString: string, newString: string): string {
  // For small strings, use direct comparison
  if (oldString.length + newString.length < 500) {
    return `${oldString.length}:${newString.length}:${oldString.slice(0, 50)}:${newString.slice(0, 50)}`;
  }
  // For larger strings, use length + first/last chars as key
  return `${oldString.length}:${newString.length}:${oldString.slice(0, 30)}:${oldString.slice(-20)}:${newString.slice(0, 30)}:${newString.slice(-20)}`;
}

/**
 * Compute diff statistics (additions and deletions count)
 * Using LCS-based algorithm for accuracy, with fallback for large files.
 * Results are cached to avoid redundant computations.
 */
function computeDiffStats(oldString: string, newString: string): { additions: number; deletions: number } {
  // Check cache first
  const cacheKey = getDiffCacheKey(oldString, newString);
  const cached = diffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const oldLines = oldString ? oldString.split('\n') : [];
  const newLines = newString ? newString.split('\n') : [];

  let result: { additions: number; deletions: number };

  if (oldLines.length === 0 && newLines.length === 0) {
    result = { additions: 0, deletions: 0 };
  } else if (oldLines.length === 0) {
    result = { additions: newLines.length, deletions: 0 };
  } else if (newLines.length === 0) {
    result = { additions: 0, deletions: oldLines.length };
  } else {
    const m = oldLines.length;
    const n = newLines.length;

    if (m > LCS_MAX_LINES || n > LCS_MAX_LINES) {
      // Fallback to simple estimation for large files to prevent UI freezes
      const diff = n - m;
      result = diff >= 0
        ? { additions: diff, deletions: 0 }
        : { additions: 0, deletions: -diff };
    } else {
      // LCS-based diff count for reasonable file sizes
      result = computeLcsDiff(oldLines, newLines, m, n);
    }
  }

  // Cache result with size limit
  if (diffCache.size >= DIFF_CACHE_MAX_SIZE) {
    // Remove oldest entry (first key)
    const firstKey = diffCache.keys().next().value;
    if (firstKey) diffCache.delete(firstKey);
  }
  diffCache.set(cacheKey, result);

  return result;
}

/**
 * LCS-based diff calculation (extracted for clarity)
 */
function computeLcsDiff(
  oldLines: string[],
  newLines: string[],
  m: number,
  n: number
): { additions: number; deletions: number } {
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let additions = 0;
  let deletions = 0;
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      additions++;
      j--;
    } else {
      deletions++;
      i--;
    }
  }

  return { additions, deletions };
}

/**
 * Extract file path from tool input (handles various naming conventions)
 * Ensures the returned value is a string, not an object (e.g., MCP tool path can be an object)
 */
function extractFilePath(input: Record<string, unknown>): string | null {
  const pathValue = input.path;
  const filePathValue = input.file_path;
  const targetFileValue = input.target_file;
  const targetFileValue2 = input.targetFile;
  const notebookPathValue = input.notebook_path;

  return (
    (typeof input.filePath === 'string' ? input.filePath : undefined) ??
    (typeof filePathValue === 'string' ? filePathValue : undefined) ??
    (typeof pathValue === 'string' ? pathValue : undefined) ??
    (typeof targetFileValue === 'string' ? targetFileValue : undefined) ??
    (typeof targetFileValue2 === 'string' ? targetFileValue2 : undefined) ??
    (typeof notebookPathValue === 'string' ? notebookPathValue : undefined) ??
    null
  );
}

/**
 * Extract old and new strings from tool input
 */
function extractStrings(input: Record<string, unknown>): { oldString: string; newString: string; replaceAll?: boolean } {
  const oldString =
    (typeof input.old_string === 'string' ? input.old_string : undefined) ??
    (typeof input.oldString === 'string' ? input.oldString : undefined) ??
    '';
  const newString =
    (typeof input.new_string === 'string' ? input.new_string : undefined) ??
    (typeof input.newString === 'string' ? input.newString : undefined) ??
    (typeof input.content === 'string' ? input.content : undefined) ?? // Write tool uses 'content'
    '';
  const replaceAll = typeof input.replace_all === 'boolean' ? input.replace_all : (typeof input.replaceAll === 'boolean' ? input.replaceAll : undefined);

  return { oldString, newString, replaceAll };
}

/**
 * Determine file status (A = Added, M = Modified)
 */
function determineFileStatus(operations: EditOperation[]): FileChangeStatus {
  return getFileChangeStatusFromOperations(operations);
}

/**
 * Check if a tool result indicates success
 */
function isSuccessfulResult(result?: ToolResultBlock | null): boolean {
  return result !== undefined && result !== null && result.is_error !== true;
}

interface UseFileChangesParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  /** Start processing messages from this index (legacy Keep All fallback) */
  startFromIndex?: number;
}

/**
 * Hook to extract and aggregate file changes from messages
 */
export function useFileChanges({
  messages,
  getContentBlocks,
  findToolResult,
  startFromIndex = 0,
}: UseFileChangesParams): FileChangeSummary[] {
  return useMemo(() => {
    // Map to collect operations by file path
    const fileOperationsMap = new Map<string, EditOperation[]>();

    // Iterate through messages starting from startFromIndex
    messages.forEach((message, messageIndex) => {
      // Skip messages before startFromIndex
      if (messageIndex < startFromIndex) return;

      if (message.type !== 'assistant') return;

      const blocks = getContentBlocks(message);

      blocks.forEach((block, blockIndex) => {
        if (block.type !== 'tool_use') return;

        const toolName = normalizeToolName(block.name ?? '');

        // Check if this is a file modification tool
        if (!isToolName(toolName, FILE_MODIFY_TOOL_NAMES)) return;

        const rawInput = block.input as Record<string, unknown> | undefined;
        const input = rawInput ? normalizeToolInput(block.name, rawInput) as Record<string, unknown> : undefined;
        if (!input) return;

        const filePath = extractFilePath(input);
        if (!filePath) return;

        // Check if operation completed successfully
        const result = findToolResult(block.id, messageIndex);
        if (!isSuccessfulResult(result)) return;

        const { oldString, newString, replaceAll } = extractStrings(input);
        const { additions, deletions } = computeDiffStats(oldString, newString);
        const lineInfo = getToolLineInfo(input, undefined, result);

        const operation: EditOperation = {
          toolName,
          oldString,
          newString,
          additions,
          deletions,
          replaceAll,
          lineStart: lineInfo.start,
          lineEnd: lineInfo.end,
          source: input.source === 'subagent' || input.source === 'codex_session_patch' || input.source === 'main'
            ? input.source
            : 'main',
          scopeId: typeof input.scope_id === 'string' ? input.scope_id : (typeof input.scopeId === 'string' ? input.scopeId : undefined),
          agentHandle: typeof input.agent_handle === 'string' ? input.agent_handle : (typeof input.agentHandle === 'string' ? input.agentHandle : undefined),
          parentToolUseId: typeof input.parent_tool_use_id === 'string' ? input.parent_tool_use_id : (typeof input.parentToolUseId === 'string' ? input.parentToolUseId : undefined),
          operationId: typeof input.operation_id === 'string' ? input.operation_id : (typeof input.operationId === 'string' ? input.operationId : undefined),
          safeToRollback: typeof input.safe_to_rollback === 'boolean' ? input.safe_to_rollback : (typeof input.safeToRollback === 'boolean' ? input.safeToRollback : undefined),
          editSequence: typeof input.edit_sequence === 'number' ? input.edit_sequence : (typeof input.editSequence === 'number' ? input.editSequence : undefined),
          existedBefore: typeof input.existed_before === 'boolean' ? input.existed_before : (typeof input.existedBefore === 'boolean' ? input.existedBefore : undefined),
          toolUseId: typeof block.id === 'string' ? block.id : undefined,
          messageIndex,
          blockIndex,
          occurrenceId: typeof block.id === 'string' ? `${messageIndex}:${block.id}` : `${messageIndex}:${blockIndex}`,
        };

        // Group by file path with defensive operation dedupe
        const existing = fileOperationsMap.get(filePath) ?? [];
        fileOperationsMap.set(filePath, addDedupedOperation(existing, filePath, operation));
      });
    });

    // Convert map to array of summaries
    const summaries: FileChangeSummary[] = [];

    fileOperationsMap.forEach((operations, filePath) => {
      // Calculate totals
      const totalAdditions = operations.reduce((sum, op) => sum + (op.additions || 0), 0);
      const totalDeletions = operations.reduce((sum, op) => sum + (op.deletions || 0), 0);

      // Defensive: ensure status is a valid string
      const rawStatus = determineFileStatus(operations);
      const status: FileChangeStatus = rawStatus === 'A' ? 'A' : 'M';

      const firstLineOperation = operations.find((op) => typeof op.lineStart === 'number');

      summaries.push({
        filePath: String(filePath || ''),
        fileName: String(getFileName(filePath) || filePath || 'unknown'),
        status,
        additions: totalAdditions,
        deletions: totalDeletions,
        lineStart: firstLineOperation?.lineStart,
        lineEnd: firstLineOperation?.lineEnd,
        operations,
      });
    });

    // Sort: Added files first, then by file path
    summaries.sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'A' ? -1 : 1;
      }
      return a.filePath.localeCompare(b.filePath);
    });

    return summaries;
  }, [messages, getContentBlocks, findToolResult, startFromIndex]);
}

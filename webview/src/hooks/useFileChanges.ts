import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import type { FileChangeSummary } from '../types/fileChanges';
import type { SubagentHistoryResponse } from '../types/subagent';
import {
  FILE_MODIFY_TOOL_NAMES,
  AGENT_TOOL_NAMES,
  isToolName,
  normalizeToolName,
} from '../utils/toolConstants';
import { normalizeToolInput } from '../utils/toolInputNormalization';
import { readPatchFiles, readPatchOutcome } from '../utils/codexPatch';
import { collectPatchLedger } from '../utils/patchLedger';
import { PATCH_TOOL_NAMES } from '../utils/toolConstants';
import { getToolLineInfo } from '../utils/toolPresentation';
import {
  buildSessionFileLedger,
  diffLineStats,
  ledgerEntriesToSummaries,
  sameLedgerOps,
  type LedgerOp,
} from '../utils/sessionFileLedger';
import {
  isMultiActorPath,
  FILE_TOUCH_TTL_MS,
  getDistinctActorsForPath,
  loadFileTouchMap,
  recordFileTouches,
  subscribeFileTouches,
  type FileTouchMap,
} from '../utils/fileTouchRegistry';

/** Cache for per-snippet diff calculations (EditToolBlock / op metadata) */
const diffCache = new Map<string, { additions: number; deletions: number }>();
const DIFF_CACHE_MAX_SIZE = 100;

/** Clear module-level diff cache (for tests). */
export function clearDiffCache(): void {
  diffCache.clear();
}

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function getDiffCacheKey(oldString: string, newString: string): string {
  return `${oldString.length}:${newString.length}:${hashString(oldString)}:${hashString(newString)}`;
}

/**
 * Compute diff statistics (additions and deletions count).
 * Small snippets use LCS; large ones use multiset estimation.
 * Used for per-operation metadata; file-level StatusPanel stats use the session ledger.
 */
export function computeDiffStats(
  oldString: string,
  newString: string,
): { additions: number; deletions: number } {
  const cacheKey = getDiffCacheKey(oldString, newString);
  const cached = diffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const result = diffLineStats(oldString, newString);

  if (diffCache.size >= DIFF_CACHE_MAX_SIZE) {
    const firstKey = diffCache.keys().next().value;
    if (firstKey) {
      diffCache.delete(firstKey);
    }
  }
  diffCache.set(cacheKey, result);
  return result;
}

function extractFilePath(input: Record<string, unknown>): string | null {
  const pathValue = input.path;
  const filePathValue = input.file_path;
  const targetFileValue = input.target_file;
  const targetFileValue2 = input.targetFile;
  const notebookPathValue = input.notebook_path;

  return (
    (typeof input.filePath === 'string' ? input.filePath : undefined)
    ?? (typeof filePathValue === 'string' ? filePathValue : undefined)
    ?? (typeof pathValue === 'string' ? pathValue : undefined)
    ?? (typeof targetFileValue === 'string' ? targetFileValue : undefined)
    ?? (typeof targetFileValue2 === 'string' ? targetFileValue2 : undefined)
    ?? (typeof notebookPathValue === 'string' ? notebookPathValue : undefined)
    ?? null
  );
}

interface StringPair {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  filePath?: string | null;
}

function pairFromRecord(record: Record<string, unknown>): StringPair {
  const oldString =
    (typeof record.old_string === 'string' ? record.old_string : undefined)
    ?? (typeof record.oldString === 'string' ? record.oldString : undefined)
    ?? (typeof record.oldText === 'string' ? record.oldText : undefined)
    ?? '';
  const newString =
    (typeof record.new_string === 'string' ? record.new_string : undefined)
    ?? (typeof record.newString === 'string' ? record.newString : undefined)
    ?? (typeof record.newText === 'string' ? record.newText : undefined)
    ?? (typeof record.content === 'string' ? record.content : undefined)
    ?? '';
  const replaceAll =
    typeof record.replace_all === 'boolean'
      ? record.replace_all
      : (typeof record.replaceAll === 'boolean' ? record.replaceAll : undefined);

  return {
    oldString,
    newString,
    replaceAll,
    filePath: extractFilePath(record),
  };
}

function extractEditPairs(input: Record<string, unknown>): StringPair[] {
  const edits = input.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    const pairs: StringPair[] = [];
    for (const item of edits) {
      if (!item || typeof item !== 'object') continue;
      const pair = pairFromRecord(item as Record<string, unknown>);
      if (pair.oldString === '' && pair.newString === '') continue;
      pairs.push(pair);
    }
    if (pairs.length > 0) return pairs;
  }

  return [pairFromRecord(input)];
}

function isSuccessfulResult(result?: ToolResultBlock | null): boolean {
  return result !== undefined && result !== null && result.is_error !== true;
}

/**
 * Content equality for summaries. The enrich effect stores derived state; callers
 * may pass unstable function props (new identity per render), which would otherwise
 * retrigger the effect forever — bailing out on equal content breaks that cycle.
 */
function sameFileChangeSummaries(a: FileChangeSummary[], b: FileChangeSummary[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.filePath !== y.filePath
      || x.fileName !== y.fileName
      || x.status !== y.status
      || x.additions !== y.additions
      || x.deletions !== y.deletions
      || x.multiAgent !== y.multiAgent
      || x.lineStart !== y.lineStart
      || x.lineEnd !== y.lineEnd
    ) {
      return false;
    }
    const xAgents = x.agentIds ?? [];
    const yAgents = y.agentIds ?? [];
    if (xAgents.length !== yAgents.length || xAgents.some((id, j) => id !== yAgents[j])) {
      return false;
    }
    const xOps = x.operations;
    const yOps = y.operations;
    if (xOps.length !== yOps.length) return false;
    for (let k = 0; k < xOps.length; k += 1) {
      const p = xOps[k];
      const q = yOps[k];
      if (
        p.toolName !== q.toolName
        || p.oldString !== q.oldString
        || p.newString !== q.newString
        || p.additions !== q.additions
        || p.deletions !== q.deletions
        || p.replaceAll !== q.replaceAll
        || p.lineStart !== q.lineStart
        || p.lineEnd !== q.lineEnd
        || p.toolUseId !== q.toolUseId || p.fileChangeKind !== q.fileChangeKind || p.moveFrom !== q.moveFrom
        || p.patch !== q.patch || p.ledgerKey !== q.ledgerKey || p.oldStringKnown !== q.oldStringKnown
      ) {
        return false;
      }
    }
  }
  return true;
}

interface FileToolInput {
  sourceId: string;
  toolUseId?: string;
  toolName: string;
  rawName?: string;
  input: Record<string, unknown>;
  result: ToolResultBlock | null | undefined;
  agentId: string;
}

function collectLedgerOpsFromToolUse(params: FileToolInput, out: LedgerOp[]): void {
  const { sourceId, toolUseId, toolName, rawName, input, result, agentId } = params;
  if (!isToolName(toolName, FILE_MODIFY_TOOL_NAMES)) return;
  if (isToolName(toolName, PATCH_TOOL_NAMES)) {
    const outcome = readPatchOutcome(input, result);
    if (!outcome.isCompleted || outcome.isError || outcome.isUnknown) return;
    for (const file of readPatchFiles(input)) {
      out.push(...collectPatchLedger(file, { sourceId, toolUseId, agentId }));
    }
    return;
  }
  if (!isSuccessfulResult(result)) return;

  const normalized = normalizeToolInput(rawName ?? toolName, input) as Record<string, unknown>;
  const defaultPath = extractFilePath(normalized);
  const pairs = extractEditPairs(normalized);
  const lineInfo = getToolLineInfo(normalized, undefined, result);

  for (const pair of pairs) {
    const filePath = pair.filePath || defaultPath;
    if (!filePath) continue;
    if (pair.oldString === '' && pair.newString === '') continue;

    out.push({
      sourceId,
      toolUseId,
      filePath,
      toolName,
      oldString: pair.oldString,
      newString: pair.newString,
      replaceAll: pair.replaceAll,
      agentId,
      lineStart: lineInfo.start,
      lineEnd: lineInfo.end,
    });
  }
}

function getRawContentBlocks(message: unknown): unknown[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  const nested = record.message;
  if (nested && typeof nested === 'object') {
    const nestedContent = (nested as Record<string, unknown>).content;
    if (Array.isArray(nestedContent)) return nestedContent;
  }
  if (Array.isArray(record.content)) return record.content;
  return [];
}

function isAssistantLike(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const record = message as Record<string, unknown>;
  if (record.type === 'assistant' || record.role === 'assistant') return true;
  const nested = record.message;
  if (nested && typeof nested === 'object') {
    const role = (nested as Record<string, unknown>).role;
    if (role === 'assistant') return true;
  }
  return false;
}

function findToolResultInRawMessages(
  messages: unknown[],
  toolUseId: string,
): ToolResultBlock | null {
  for (const message of messages) {
    for (const block of getRawContentBlocks(message)) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      if (item.type === 'tool_result' && item.tool_use_id === toolUseId) {
        return item as unknown as ToolResultBlock;
      }
    }
  }
  return null;
}

function collectFromSubagentHistories(
  out: FileToolInput[],
  subagentHistories: Record<string, SubagentHistoryResponse>,
  allowedKeys: Set<string> | null,
): void {
  for (const [key, history] of Object.entries(subagentHistories)) {
    if (!history?.success || !Array.isArray(history.messages)) continue;
    if (allowedKeys && !allowedKeys.has(key)) {
      if (!history.agentId || !allowedKeys.has(history.agentId)) {
        if (!history.toolUseId || !allowedKeys.has(history.toolUseId)) {
          continue;
        }
      }
    }

    const agentId =
      (typeof history.agentId === 'string' && history.agentId)
      || (typeof history.toolUseId === 'string' && history.toolUseId)
      || key;

    const rawMessages = history.messages;
    for (const message of rawMessages) {
      if (!isAssistantLike(message)) continue;
      for (const block of getRawContentBlocks(message)) {
        if (!block || typeof block !== 'object') continue;
        const item = block as Record<string, unknown>;
        if (item.type !== 'tool_use') continue;

        const name = typeof item.name === 'string' ? item.name : '';
        const toolName = normalizeToolName(name);
        if (!isToolName(toolName, FILE_MODIFY_TOOL_NAMES)) continue;

        const toolUseId = typeof item.id === 'string' ? item.id : undefined;
        if (!toolUseId) continue;

        const result = findToolResultInRawMessages(rawMessages, toolUseId);
        const rawInput = item.input;
        if (!rawInput || typeof rawInput !== 'object') continue;

        out.push({
          sourceId: `subagent:${key}`,
          toolUseId,
          toolName,
          rawName: name,
          input: rawInput as Record<string, unknown>,
          result,
          agentId,
        });
      }
    }
  }
}

interface UseFileChangesParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  /** Start processing messages from this index (for Keep All feature) */
  startFromIndex?: number;
  ignoredLedgerKeys?: string[];
  /** Background agent sidechain transcripts — their Edit/Write tools must also count */
  subagentHistories?: Record<string, SubagentHistoryResponse>;
  /** Current chat tab session id — for cross-tab multi-agent marks */
  currentSessionId?: string | null;
}

/**
 * Attribute main-stream tool_use blocks the same way groupBlocks absorbs them
 * into Agent/Task groups: after an Agent/Task id, following tool_use blocks belong
 * to that agent until a non-tool boundary (text/thinking/…). Without this, every
 * Edit is labeled "main" and multi-agent badges never appear when two agents
 * both write via the main transcript (or absorbed tools after Task).
 */
function resolveAgentIdForMainStreamBlocks(
  blocks: ClaudeContentBlock[],
): Map<string, string> {
  /** tool_use id → agent key ("main" or Agent/Task tool_use id) */
  const ownerByToolId = new Map<string, string>();
  let activeAgentId = 'main';

  for (const block of blocks) {
    if (block.type !== 'tool_use') {
      // Same boundary as groupBlocks: non-tool ends agent absorption
      activeAgentId = 'main';
      continue;
    }

    const rawName = block.name ?? '';
    const toolName = normalizeToolName(rawName);
    const toolId = typeof block.id === 'string' ? block.id : undefined;

    if (isToolName(toolName, AGENT_TOOL_NAMES) && toolId) {
      activeAgentId = toolId;
      ownerByToolId.set(toolId, toolId);
      continue;
    }

    if (toolId) {
      ownerByToolId.set(toolId, activeAgentId);
    }
  }

  return ownerByToolId;
}

/**
 * Extract file changes from messages using a session ledger:
 * net diff(baseline, current) per file, multi-agent flag when ≥2 agents touch a file.
 * Rebuilds from messages so switching back from history keeps stats.
 */
export function useFileChanges({
  messages,
  getContentBlocks,
  findToolResult,
  startFromIndex = 0,
  ignoredLedgerKeys,
  subagentHistories,
  currentSessionId = null,
}: UseFileChangesParams): FileChangeSummary[] {
  const cache = useMemo(() => ({ inputs: [] as FileToolInput[], ops: [] as LedgerOp[] }),
    [currentSessionId, startFromIndex]);
  const inputs = useMemo(() => {
    const collected: FileToolInput[] = [];
    const agentKeysAfterBase = new Set<string>();

    messages.forEach((message, messageIndex) => {
      if (messageIndex < startFromIndex) return;
      if (message.type !== 'assistant') return;

      const blocks = getContentBlocks(message);
      const ownerByToolId = resolveAgentIdForMainStreamBlocks(blocks);

      blocks.forEach((block) => {
        if (block.type !== 'tool_use') return;

        const rawName = block.name ?? '';
        const toolName = normalizeToolName(rawName);

        if (isToolName(toolName, AGENT_TOOL_NAMES) && block.id) {
          agentKeysAfterBase.add(block.id);
        }

        if (!isToolName(toolName, FILE_MODIFY_TOOL_NAMES)) return;

        const rawInput = block.input as Record<string, unknown> | undefined;
        if (!rawInput) return;

        const toolId = typeof block.id === 'string' ? block.id : undefined;
        const agentId = (toolId && ownerByToolId.get(toolId)) || 'main';

        const result = findToolResult(block.id, messageIndex);
        collected.push({
          sourceId: 'main',
          toolUseId: toolId,
          toolName,
          rawName,
          input: rawInput,
          result,
          agentId,
        });
      });
    });

    if (subagentHistories && Object.keys(subagentHistories).length > 0) {
      const allowedKeys = startFromIndex > 0 ? agentKeysAfterBase : null;
      collectFromSubagentHistories(
        collected,
        subagentHistories,
        allowedKeys && allowedKeys.size > 0
          ? allowedKeys
          : (startFromIndex > 0 ? agentKeysAfterBase : null),
      );
    }

    const unique = new Map<string | FileToolInput, FileToolInput>();
    for (const input of collected) {
      const key = input.toolUseId ? JSON.stringify([input.sourceId, input.toolUseId]) : input;
      unique.set(key, input);
    }
    const next = [...unique.values()];
    if (cache.inputs.length !== next.length || next.some((input, index) => {
      const previous = cache.inputs[index];
      return input.sourceId !== previous.sourceId
        || input.toolUseId !== previous.toolUseId || input.agentId !== previous.agentId
        || input.toolName !== previous.toolName || input.rawName !== previous.rawName
        || input.input !== previous.input || input.result !== previous.result;
    })) {
      cache.inputs = next;
    }
    return cache.inputs;
  }, [messages, getContentBlocks, findToolResult, startFromIndex, subagentHistories, cache]);

  const ops = useMemo(() => {
    const collected: LedgerOp[] = [];
    for (const input of inputs) collectLedgerOpsFromToolUse(input, collected);
    const ignored = new Set(ignoredLedgerKeys);
    const next = ignored.size ? collected.filter(op => !ignored.has(JSON.stringify([op.sourceId, op.toolUseId, op.filePath]))) : collected;
    if (!sameLedgerOps(cache.ops, next)) cache.ops = next;
    return cache.ops;
  }, [inputs, cache, ignoredLedgerKeys]);

  const base = useMemo(() => {
    const entries = buildSessionFileLedger(ops);
    const summaries = ledgerEntriesToSummaries(entries);
    return { summaries };
  }, [ops]);

  const [enriched, setEnriched] = useState<FileChangeSummary[]>(base.summaries);
  const recorded = useRef({
    sessionId: currentSessionId,
    assignments: new Map<string, { filePath: string; agentId: string }>(),
    map: {} as FileTouchMap,
    outsideUntil: new Map<string, number>(),
  });
  const isEmpty = messages.length === 0 && inputs.length === 0;

  useEffect(() => {
    if (recorded.current.sessionId !== currentSessionId || isEmpty) {
      recorded.current = { sessionId: currentSessionId, assignments: new Map(), map: {}, outsideUntil: new Map() };
    }
    const { summaries } = base;
    if (!currentSessionId) {
      setEnriched((prev) => (sameFileChangeSummaries(prev, summaries) ? prev : summaries));
      return;
    }

    const rememberOutside = (map: FileTouchMap) => {
      for (const summary of summaries) {
        for (const actor of getDistinctActorsForPath(summary.filePath, map)) {
          if (actor.sessionId === currentSessionId) continue;
          recorded.current.outsideUntil.set(summary.filePath, Math.max(
            recorded.current.outsideUntil.get(summary.filePath) ?? 0,
            actor.updatedAt + FILE_TOUCH_TTL_MS + 1,
          ));
        }
      }
    };

    const agentsByPath = new Map<string, string[]>();
    const replacedOwners: Array<{ filePath: string; agentId: string }> = [];
    for (const op of ops) {
      const key = JSON.stringify([
        op.filePath, op.sourceId,
        op.toolUseId ?? [op.toolName, op.oldString, op.newString, op.replaceAll],
      ]);
      const previous = recorded.current.assignments.get(key);
      if (previous?.agentId === op.agentId) continue;
      if (previous) replacedOwners.push(previous);
      recorded.current.assignments.set(key, { filePath: op.filePath, agentId: op.agentId });
      const agents = agentsByPath.get(op.filePath) ?? [];
      if (!agents.includes(op.agentId)) agents.push(op.agentId);
      agentsByPath.set(op.filePath, agents);
    }
    if (agentsByPath.size > 0) {
      const now = Date.now();
      const priorMap = loadFileTouchMap(now);
      rememberOutside(priorMap);
      const map = { ...priorMap };
      for (const previous of replacedOwners) {
        if ([...recorded.current.assignments.values()].some((assignment) =>
          assignment.filePath === previous.filePath && assignment.agentId === previous.agentId)) continue;
        map[previous.filePath] = (map[previous.filePath] ?? []).filter((actor) =>
          actor.sessionId !== currentSessionId || actor.agentId !== previous.agentId);
      }
      recorded.current.map = recordFileTouches(
        [...agentsByPath.keys()], currentSessionId, agentsByPath, now, map,
      );
    }
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (map: FileTouchMap) => {
      clearTimeout(expiryTimer);
      recorded.current.map = map;
      if (Object.keys(map).length === 0) recorded.current.outsideUntil.clear();
      rememberOutside(map);
      const now = Date.now();
      for (const [path, expiry] of recorded.current.outsideUntil) {
        if (expiry <= now) recorded.current.outsideUntil.delete(path);
      }
      let nextExpiry = Infinity;
      const next = summaries.map((summary) => {
        const outsideExpiry = recorded.current.outsideUntil.get(summary.filePath) ?? 0;
        if (outsideExpiry > now) nextExpiry = Math.min(nextExpiry, outsideExpiry);
        for (const actor of getDistinctActorsForPath(summary.filePath, map)) {
          nextExpiry = Math.min(nextExpiry, actor.updatedAt + FILE_TOUCH_TTL_MS + 1);
        }
        return {
          ...summary,
          multiAgent: summary.multiAgent === true || isMultiActorPath(summary.filePath, map),
          status: outsideExpiry > now && summary.status === 'A' ? 'M' as const : summary.status,
        };
      });
      setEnriched((prev) => (sameFileChangeSummaries(prev, next) ? prev : next));
      if (Number.isFinite(nextExpiry)) {
        expiryTimer = setTimeout(() => refresh(recorded.current.map), Math.max(1, nextExpiry - now));
      }
    };
    refresh(recorded.current.map);
    const unsubscribe = subscribeFileTouches(refresh);
    return () => {
      unsubscribe();
      clearTimeout(expiryTimer);
    };
  }, [base, ops, currentSessionId, isEmpty]);

  return enriched;
}

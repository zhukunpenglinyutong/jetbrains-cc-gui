import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeRawMessage, ClaudeContentBlock, ToolResultBlock, SubagentInfo, SubagentStatus } from '../types';
import { normalizeToolInput } from '../utils/toolInputNormalization';
import { normalizeToolName } from '../utils/toolConstants';

type GetToolResultRawFn = (toolUseId: string) => ClaudeRawMessage | null;

interface UseSubagentsParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  getToolResultRaw: GetToolResultRawFn;
}

const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const CODEX_START_TOOLS = new Set(['spawn_agent', 'send_input', 'resume_agent']);
const CODEX_TERMINAL_TOOLS = new Set(['wait_agent', 'close_agent']);

/**
 * Determine subagent status based on tool result.
 */
function determineStatus(result: ToolResultBlock | null): SubagentStatus {
  if (!result) {
    return 'running';
  }
  if (result.is_error) {
    return 'error';
  }
  return 'completed';
}

function extractResultText(result: ToolResultBlock | null): string | undefined {
  if (!result) return undefined;
  if (typeof result.content === 'string') return result.content;
  if (!Array.isArray(result.content)) return undefined;
  const text = result.content
    .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function extractResultMetadata(
  result: ToolResultBlock | null,
  getToolResultRaw: GetToolResultRawFn,
  toolUseId: string,
): Partial<SubagentInfo> {
  const rawMessage = getToolResultRaw(toolUseId);
  const metadata = rawMessage?.toolUseResult;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { resultText: extractResultText(result) };
  }

  const record = metadata as Record<string, unknown>;
  const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const getNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const toolStats = record.toolStats && typeof record.toolStats === 'object' && !Array.isArray(record.toolStats)
    ? Object.fromEntries(
      Object.entries(record.toolStats as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
    )
    : undefined;

  return {
    agentId: getString(record.agentId),
    totalDurationMs: getNumber(record.totalDurationMs),
    totalTokens: getNumber(record.totalTokens),
    totalToolUseCount: getNumber(record.totalToolUseCount),
    toolStats,
    resultText: extractResultText(result),
  };
}

function addStringHandle(handles: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim().length > 0) {
    handles.add(value.trim());
  }
}

function extractTargetArrayHandles(value: unknown): Set<string> {
  const handles = new Set<string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return handles;
  }
  const targets = (value as Record<string, unknown>).targets;
  if (Array.isArray(targets)) {
    targets.forEach((target) => addStringHandle(handles, target));
  }
  return handles;
}

function extractHandlesFromObject(value: unknown, includeTargets = true): Set<string> {
  const handles = new Set<string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return handles;
  }
  const object = value as Record<string, unknown>;
  [
    'agentHandle', 'agent_handle', 'agentId', 'agent_id', 'agentPath', 'agent_path',
    'target', 'id', 'path',
  ].forEach((key) => addStringHandle(handles, object[key]));

  if (includeTargets) {
    extractTargetArrayHandles(object).forEach((handle) => handles.add(handle));
  }

  return handles;
}

function isPlausiblePlainTextHandle(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 512 || trimmed.includes('\n')) {
    return false;
  }
  if (/^(\/|~\/|[A-Za-z]:[\\/])/.test(trimmed)) {
    return true;
  }
  if (/^[A-Za-z0-9._:-]+$/.test(trimmed) && /(agent|codex|[0-9a-fA-F]{6,})/i.test(trimmed)) {
    return true;
  }
  return false;
}

function extractTextFromResult(result: ToolResultBlock | null): string {
  if (!result || result.content === undefined || result.content === null) {
    return '';
  }
  if (typeof result.content === 'string') {
    return result.content;
  }
  if (Array.isArray(result.content)) {
    return result.content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function extractHandlesFromResult(
  result: ToolResultBlock | null,
  allowPlainTextHandle = false,
  includeTargets = true,
  allowMultipleUuidHandles = true,
): Set<string> {
  const handles = new Set<string>();
  const text = extractTextFromResult(result).trim();
  if (!text) {
    return handles;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    extractHandlesFromObject(parsed, includeTargets).forEach((handle) => handles.add(handle));
  } catch {
    // Fall through to text extraction.
  }

  const uuidMatches = Array.from(text.matchAll(UUID_PATTERN), (match) => match[0]);
  if (allowMultipleUuidHandles || uuidMatches.length === 1) {
    uuidMatches.forEach((handle) => handles.add(handle));
  }

  if (allowPlainTextHandle && handles.size === 0 && isPlausiblePlainTextHandle(text)) {
    handles.add(text);
  }

  return handles;
}

function ensureCodexSubagent(
  subagents: SubagentInfo[],
  byHandle: Map<string, SubagentInfo>,
  id: string,
  handle: string | undefined,
  type: string,
  description: string,
  prompt: string,
  status: SubagentStatus,
  messageIndex: number,
): SubagentInfo {
  const existing = handle ? byHandle.get(handle) : undefined;
  if (existing) {
    existing.status = status;
    if (!existing.agentHandle) existing.agentHandle = handle;
    return existing;
  }

  const subagent: SubagentInfo = {
    id,
    type,
    description,
    prompt,
    status,
    provider: 'codex',
    agentHandle: handle,
    messageIndex,
  };
  subagents.push(subagent);
  if (handle) {
    byHandle.set(handle, subagent);
  }
  return subagent;
}

export function extractSubagentsFromMessages(
  messages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null,
  getToolResultRaw: GetToolResultRawFn,
): SubagentInfo[] {
  const subagents: SubagentInfo[] = [];
  const codexSubagentByHandle = new Map<string, SubagentInfo>();

  messages.forEach((message, messageIndex) => {
    if (message.type !== 'assistant') return;

    const blocks = getContentBlocks(message);

    blocks.forEach((block, blockIndex) => {
      if (block.type !== 'tool_use') return;

      const toolName = normalizeToolName(block.name ?? '');
      const rawInput = block.input as Record<string, unknown> | undefined;
      const input = rawInput ? normalizeToolInput(block.name, rawInput) as Record<string, unknown> : undefined;
      if (!input) return;

      const id = String(block.id ?? `${toolName}-${messageIndex}-${blockIndex}`);
      const toolUseId = block.id ?? '';
      const result = findToolResult(toolUseId, messageIndex);

      if (toolName === 'task' || toolName === 'agent') {
        const resultMetadata = extractResultMetadata(result, getToolResultRaw, toolUseId);
        subagents.push({
          id,
          type: String((input.subagent_type as string) ?? (input.subagentType as string) ?? 'Unknown'),
          description: String((input.description as string) ?? ''),
          prompt: String((input.prompt as string) ?? ''),
          status: determineStatus(result),
          provider: 'claude',
          messageIndex,
          ...resultMetadata,
        });
        return;
      }

      if (CODEX_START_TOOLS.has(toolName)) {
        const resultHandles = result && !result.is_error
          ? extractHandlesFromResult(result, toolName === 'spawn_agent')
          : new Set<string>();
        const inputHandles = extractHandlesFromObject(input);
        const handles = toolName === 'spawn_agent'
          ? (resultHandles.size > 0 ? resultHandles : inputHandles)
          : (inputHandles.size > 0 ? inputHandles : resultHandles);
        const fallbackHandle = handles.values().next().value as string | undefined;
        const status: SubagentStatus = result?.is_error || (toolName === 'spawn_agent' && !!result && handles.size === 0)
          ? 'error'
          : 'running';
        const type = String(input.agent_type ?? input.agentType ?? toolName);
        const description = String(input.description ?? input.name ?? fallbackHandle ?? toolName);
        const prompt = String(input.prompt ?? input.message ?? '');

        if (handles.size === 0) {
          ensureCodexSubagent(subagents, codexSubagentByHandle, id, undefined, type, description, prompt, status, messageIndex);
          return;
        }

        handles.forEach((handle) => {
          ensureCodexSubagent(subagents, codexSubagentByHandle, id, handle, type, description, prompt, status, messageIndex);
        });
        return;
      }

      if (CODEX_TERMINAL_TOOLS.has(toolName)) {
        const resultHandles = toolName === 'wait_agent'
          ? extractHandlesFromResult(result, false, false, false)
          : extractHandlesFromResult(result);
        const directInputHandles = extractHandlesFromObject(input, false);
        const targetArrayHandles = extractTargetArrayHandles(input);
        const handles = new Set<string>();

        if (toolName === 'wait_agent') {
          if (resultHandles.size > 0) {
            resultHandles.forEach((handle) => handles.add(handle));
          } else if (directInputHandles.size > 0) {
            directInputHandles.forEach((handle) => handles.add(handle));
          } else if (targetArrayHandles.size === 1) {
            targetArrayHandles.forEach((handle) => handles.add(handle));
          }
        } else {
          directInputHandles.forEach((handle) => handles.add(handle));
          targetArrayHandles.forEach((handle) => handles.add(handle));
          resultHandles.forEach((handle) => handles.add(handle));
        }

        const status: SubagentStatus = result?.is_error ? 'error' : (result ? 'completed' : 'running');
        handles.forEach((handle) => {
          const existing = codexSubagentByHandle.get(handle);
          if (existing) {
            existing.status = status;
          }
        });
      }
    });
  });

  return subagents;
}

/**
 * Hook to extract subagent information from Task tool calls.
 */
export function useSubagents({
  messages,
  getContentBlocks,
  findToolResult,
  getToolResultRaw,
}: UseSubagentsParams): SubagentInfo[] {
  return useMemo(
    () => extractSubagentsFromMessages(messages, getContentBlocks, findToolResult, getToolResultRaw),
    [messages, getContentBlocks, findToolResult, getToolResultRaw],
  );
}

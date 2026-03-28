import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock, SubagentInfo, SubagentStatus } from '../types';
import { normalizeToolInput } from '../utils/toolInputNormalization';
import { normalizeToolName } from '../utils/toolConstants';

interface UseSubagentsParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
}

/**
 * Determine subagent status based on tool result
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

/**
 * Hook to extract subagent information from Task tool calls
 */
export function useSubagents({
  messages,
  getContentBlocks,
  findToolResult,
}: UseSubagentsParams): SubagentInfo[] {
  return useMemo(() => {
    const subagents: SubagentInfo[] = [];

    messages.forEach((message, messageIndex) => {
      if (message.type !== 'assistant') return;

      const blocks = getContentBlocks(message);

      blocks.forEach((block) => {
        if (block.type !== 'tool_use') return;

        const toolName = normalizeToolName(block.name ?? '');

        // Only process task/agent-style subagent tool calls.
        if (toolName !== 'task' && toolName !== 'agent' && toolName !== 'spawn_agent') return;

        const rawInput = block.input as Record<string, unknown> | undefined;
        const input = rawInput ? normalizeToolInput(block.name, rawInput) as Record<string, unknown> : undefined;
        if (!input) return;

        // Defensive: ensure all string values are actually strings
        const id = String(block.id ?? `task-${messageIndex}-${subagents.length}`);
        const subagentType = String((input.subagent_type as string) ?? (input.subagentType as string) ?? 'Unknown');
        const description = String((input.description as string) ?? '');
        const prompt = String((input.prompt as string) ?? '');

        // Check tool result to determine status
        const result = findToolResult(block.id, messageIndex);
        const status = determineStatus(result);

        subagents.push({
          id,
          type: subagentType,
          description,
          prompt,
          status,
          messageIndex,
        });
      });
    });

    return subagents;
  }, [messages, getContentBlocks, findToolResult]);
}

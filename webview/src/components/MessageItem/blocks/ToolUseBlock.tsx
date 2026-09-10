import { memo, useMemo } from 'react';
import {
  BashToolBlock,
  EditToolBlock,
  GenericToolBlock,
  ReportFindingsToolBlock,
  TaskExecutionBlock,
  parseReportFindingsInput,
} from '../../toolBlocks';
import type { EditToolItem } from '../../toolBlocks/EditToolBlock';
import { EDIT_TOOL_NAMES, BASH_TOOL_NAMES, TASK_MANAGE_TOOL_NAMES, AGENT_TOOL_NAMES, REPORT_FINDINGS_TOOL_NAMES, isToolName, isTransientInternalToolName, normalizeToolName } from '../../../utils/toolConstants';
import type { ClaudeContentBlock, ToolResultBlock } from '../../../types';

/**
 * Stable adapter for a single edit call. Building the one-item array inline in
 * render would hand EditToolBlock a fresh array (and wrapper object) on every
 * parent render and defeat its memo. Routing through this memoized wrapper
 * means EditToolBlock only re-renders when the underlying call's primitives
 * actually change, so it stays quiet while sibling blocks drive the streaming
 * message's frequent re-renders.
 */
const SingleEditToolBlock = memo(function SingleEditToolBlock({
  name,
  input,
  result,
  toolId,
}: EditToolItem) {
  return <EditToolBlock items={[{ name, input, result, toolId }]} />;
});

interface ToolUseBlockProps {
  block: Extract<ClaudeContentBlock, { type: 'tool_use' }>;
  messageIndex: number;
  isStreaming: boolean;
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
}

export function ToolUseBlock({ block, messageIndex, isStreaming, findToolResult }: ToolUseBlockProps) {
  const toolName = normalizeToolName(block.name ?? '');
  // Parse once per input snapshot: rebuilding the findings array on every
  // streaming re-render would defeat the memo on the specialized block.
  const report = useMemo(() => parseReportFindingsInput(block.input), [block.input]);

  if (toolName === 'todowrite' || toolName === 'update_plan' || TASK_MANAGE_TOOL_NAMES.has(toolName)) {
    return null;
  }

  if (!isStreaming && isTransientInternalToolName(block.name)) {
    return null;
  }

  if (REPORT_FINDINGS_TOOL_NAMES.has(toolName) && report) {
    return (
      <ReportFindingsToolBlock
        data={report}
        result={findToolResult(block.id, messageIndex)}
        toolId={block.id}
      />
    );
  }

  if (AGENT_TOOL_NAMES.has(toolName)) {
    return (
      <TaskExecutionBlock
        name={block.name}
        input={block.input}
        result={findToolResult(block.id, messageIndex)}
        toolId={block.id}
        isStreaming={isStreaming}
      />
    );
  }

  if (isToolName(block.name, EDIT_TOOL_NAMES)) {
    return (
      <SingleEditToolBlock
        name={block.name}
        input={block.input}
        result={findToolResult(block.id, messageIndex)}
        toolId={block.id}
      />
    );
  }

  if (isToolName(block.name, BASH_TOOL_NAMES)) {
    return (
      <BashToolBlock
        name={block.name}
        input={block.input}
        result={findToolResult(block.id, messageIndex)}
        toolId={block.id}
      />
    );
  }

  return (
    <GenericToolBlock
      name={block.name}
      input={block.input}
      result={findToolResult(block.id, messageIndex)}
      toolId={block.id}
    />
  );
}

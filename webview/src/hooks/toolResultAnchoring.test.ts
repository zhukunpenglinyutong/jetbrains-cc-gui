// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ClaudeContentBlock, ClaudeMessage, ToolResultBlock } from '../types';
import { useSubagents } from './useSubagents';
import { useFileChanges } from './useFileChanges';

function makeAssistantMessage(content: ClaudeContentBlock[], extra?: Partial<ClaudeMessage>): ClaudeMessage {
  return {
    type: 'assistant',
    raw: { message: { content } } as any,
    ...extra,
  };
}

describe('tool result anchor regressions', () => {
  it('useSubagents passes the assistant message as anchor when resolving task status', () => {
    const assistant = makeAssistantMessage([
      {
        type: 'tool_use',
        id: 'task-1',
        name: 'Task',
        input: {
          subagent_type: 'Explore',
          description: 'Inspect history hydration',
          prompt: 'Check tool result resolution after history load',
        },
      },
    ], {
      __turnId: 8,
      content: 'run task',
    });

    const messages: ClaudeMessage[] = [assistant];
    const findToolResultCalls: Array<[string | undefined, number | undefined, ClaudeMessage | undefined]> = [];
    const completedResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'task-1',
      content: 'done',
    };

    const { result } = renderHook(() => useSubagents({
      messages,
      getContentBlocks: (message) => ((message.raw as any)?.message?.content ?? []) as ClaudeContentBlock[],
      findToolResult: (toolUseId, messageIndex, anchorMessage) => {
        findToolResultCalls.push([toolUseId, messageIndex, anchorMessage]);
        return completedResult;
      },
    }));

    expect(findToolResultCalls).toEqual([['task-1', 0, assistant]]);
    expect(result.current).toEqual([
      {
        id: 'task-1',
        type: 'Explore',
        description: 'Inspect history hydration',
        prompt: 'Check tool result resolution after history load',
        status: 'completed',
        messageIndex: 0,
      },
    ]);
  });

  it('useFileChanges passes the assistant message as anchor and keeps successful history-loaded edits', () => {
    const assistant = makeAssistantMessage([
      {
        type: 'tool_use',
        id: 'edit-1',
        name: 'Edit',
        input: {
          file_path: '/tmp/demo.txt',
          old_string: 'before',
          new_string: 'after',
        },
      },
    ], {
      __turnId: 11,
      content: 'edit file',
    });

    const messages: ClaudeMessage[] = [assistant];
    const findToolResultCalls: Array<[string | undefined, number | undefined, ClaudeMessage | undefined]> = [];
    const successfulResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'edit-1',
      content: 'ok',
    };

    const { result } = renderHook(() => useFileChanges({
      messages,
      getContentBlocks: (message) => ((message.raw as any)?.message?.content ?? []) as ClaudeContentBlock[],
      findToolResult: (toolUseId, messageIndex, anchorMessage) => {
        findToolResultCalls.push([toolUseId, messageIndex, anchorMessage]);
        return successfulResult;
      },
    }));

    expect(findToolResultCalls).toEqual([['edit-1', 0, assistant]]);
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      filePath: '/tmp/demo.txt',
      fileName: 'demo.txt',
      status: 'M',
      additions: 1,
      deletions: 1,
    });
  });
});

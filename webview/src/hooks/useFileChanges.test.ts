import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFileChanges } from './useFileChanges';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';

const successResult: ToolResultBlock = { type: 'tool_result', tool_use_id: 'unused', content: 'ok', is_error: false } as any;

const messageWithEdit = (id: string, source: 'subagent' | 'codex_session_patch', editSequence = 1): ClaudeMessage => ({
  type: 'assistant',
  content: '',
  timestamp: new Date().toISOString(),
  raw: {},
  blocks: [{
    type: 'tool_use',
    id,
    name: 'edit',
    input: {
      file_path: '/repo/a.ts',
      old_string: 'before',
      new_string: 'after',
      source,
      scope_id: 'scope-1',
      operation_id: `${source}-op`,
      safe_to_rollback: true,
      edit_sequence: editSequence,
    },
  } as any],
} as ClaudeMessage);

describe('useFileChanges', () => {
  it('dedupes duplicate operations regardless of source metadata', () => {
    const messages = [
      messageWithEdit('tool-1', 'codex_session_patch', 4),
      messageWithEdit('tool-2', 'subagent', 4),
    ];
    const { result } = renderHook(() => useFileChanges({
      messages,
      getContentBlocks: (message) => (message as any).blocks as ClaudeContentBlock[],
      findToolResult: () => successResult,
    }));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].operations).toHaveLength(1);
    expect(result.current[0].operations[0].source).toBe('codex_session_patch');
    expect(result.current[0].operations[0].editSequence).toBe(4);
  });

  it('keeps later synthetic operations even when edit sequence values repeat', () => {
    const messages = [messageWithEdit('tool-1', 'subagent', 1), messageWithEdit('tool-2', 'codex_session_patch', 1)];
    (messages[1] as any).blocks[0].input.operation_id = 'codex-session-next-turn-op';

    const { result } = renderHook(() => useFileChanges({
      messages,
      getContentBlocks: (message) => (message as any).blocks as ClaudeContentBlock[],
      findToolResult: () => successResult,
      startFromIndex: 1,
    }));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].operations[0].source).toBe('codex_session_patch');
    expect(result.current[0].operations[0].editSequence).toBe(1);
  });


  it('treats empty oldString edit on an existing file as modified, not added', () => {
    const messages: ClaudeMessage[] = [{
      type: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      raw: {},
      blocks: [{
        type: 'tool_use',
        id: 'insert-1',
        name: 'edit',
        input: { file_path: '/repo/empty.txt', old_string: '', new_string: 'content' },
      } as any],
    } as ClaudeMessage];

    const { result } = renderHook(() => useFileChanges({
      messages,
      getContentBlocks: (message) => (message as any).blocks as ClaudeContentBlock[],
      findToolResult: () => successResult,
    }));

    expect(result.current[0].status).toBe('M');
  });

  it('keeps repeated same hunk operations distinct when tool ids differ', () => {
    const messages = [
      messageWithEdit('tool-1', 'subagent', 1),
      messageWithEdit('tool-2', 'subagent', 2),
    ];
    (messages[1] as any).blocks[0].input.operation_id = 'subagent-op-2';

    const { result } = renderHook(() => useFileChanges({
      messages,
      getContentBlocks: (message) => (message as any).blocks as ClaudeContentBlock[],
      findToolResult: () => successResult,
    }));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].operations).toHaveLength(2);
  });


  it('treats write operation with existedBefore true as modified', () => {
    const messages: ClaudeMessage[] = [{
      type: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      raw: {},
      blocks: [{
        type: 'tool_use',
        id: 'write-existing',
        name: 'write',
        input: { file_path: '/repo/existing.txt', content: 'replacement', existed_before: true },
      } as any],
    } as ClaudeMessage];

    const { result } = renderHook(() => useFileChanges({
      messages,
      getContentBlocks: (message) => (message as any).blocks as ClaudeContentBlock[],
      findToolResult: () => successResult,
    }));

    expect(result.current[0].status).toBe('M');
  });


  it('shows Codex filesystem snapshot writes as added files', () => {
    const messages: ClaudeMessage[] = [{
      type: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      raw: {},
      blocks: [{
        type: 'tool_use',
        id: 'codex-fs-1',
        name: 'write',
        input: {
          file_path: '/repo/src/generated.js',
          old_string: '',
          new_string: 'export const generated = true;\n',
          source: 'codex_session_patch',
          operation_id: 'codex-fs-1',
          safe_to_rollback: true,
          existed_before: false,
        },
      } as any],
    } as ClaudeMessage];

    const { result } = renderHook(() => useFileChanges({
      messages,
      getContentBlocks: (message) => (message as any).blocks as ClaudeContentBlock[],
      findToolResult: () => successResult,
    }));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].filePath).toBe('/repo/src/generated.js');
    expect(result.current[0].status).toBe('A');
    expect(result.current[0].operations[0].source).toBe('codex_session_patch');
    expect(result.current[0].operations[0].safeToRollback).toBe(true);
  });

});

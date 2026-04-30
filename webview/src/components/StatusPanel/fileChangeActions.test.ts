import { describe, expect, it } from 'vitest';
import { filterProcessedFileChanges, getFilesToDiscardAfterUndoAll, getProcessedOperationKeys, getSucceededFilesFromUndoAllResult, toBridgeOperations } from './fileChangeActions';
import type { EditOperation } from '../../types';

describe('fileChangeActions', () => {
  it('preserves operation metadata for Java bridge payloads', () => {
    const operations: EditOperation[] = [{
      toolName: 'edit',
      oldString: 'before',
      newString: 'after',
      additions: 1,
      deletions: 1,
      replaceAll: false,
      lineStart: 10,
      lineEnd: 12,
      operationId: 'op-1',
      source: 'subagent',
      scopeId: 'scope-1',
      agentHandle: 'agent-1',
      parentToolUseId: 'parent-1',
      safeToRollback: true,
      editSequence: 9,
    }];

    expect(toBridgeOperations(operations)).toEqual([{
      oldString: 'before',
      newString: 'after',
      replaceAll: false,
      lineStart: 10,
      lineEnd: 12,
      operationId: 'op-1',
      source: 'subagent',
      scopeId: 'scope-1',
      agentHandle: 'agent-1',
      parentToolUseId: 'parent-1',
      safeToRollback: true,
      editSequence: 9,
    }]);
  });


  it('uses request snapshot when undo all succeeds without succeededFiles', () => {
    expect(getFilesToDiscardAfterUndoAll({ success: true }, ['/repo/a.ts', '/repo/b.ts'])).toEqual([
      '/repo/a.ts',
      '/repo/b.ts',
    ]);
  });

  it('uses backend succeededFiles before request snapshot', () => {
    expect(getFilesToDiscardAfterUndoAll({ success: true, succeededFiles: ['/repo/a.ts'] }, ['/repo/a.ts', '/repo/b.ts'])).toEqual([
      '/repo/a.ts',
    ]);
  });

  it('returns only succeeded files for partial undo all result', () => {
    const result = {
      success: false,
      partial: true,
      succeededFiles: ['/repo/a.ts'],
      failedFiles: [{ filePath: '/repo/b.ts', reason: 'new_string_not_found' }],
    };

    expect(getSucceededFilesFromUndoAllResult(result)).toEqual(['/repo/a.ts']);
  });

  it('filters processed operations without hiding future operations on the same file', () => {
    const oldOperation: EditOperation = {
      toolName: 'edit',
      oldString: 'before',
      newString: 'after',
      additions: 1,
      deletions: 1,
      operationId: 'op-old',
      editSequence: 1,
    };
    const futureOperation: EditOperation = {
      toolName: 'edit',
      oldString: 'after',
      newString: 'future',
      additions: 1,
      deletions: 1,
      operationId: 'op-future',
      editSequence: 2,
    };
    const fileChange = {
      filePath: '/repo/a.ts',
      fileName: 'a.ts',
      status: 'M' as const,
      additions: 2,
      deletions: 2,
      operations: [oldOperation, futureOperation],
    };

    const processedKeys = getProcessedOperationKeys('/repo/a.ts', [oldOperation]);
    const filtered = filterProcessedFileChanges([fileChange], processedKeys);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].operations).toEqual([futureOperation]);
    expect(filtered[0].additions).toBe(1);
    expect(filtered[0].deletions).toBe(1);
  });

  it('uses operation fingerprint when operationId is missing', () => {
    const operation: EditOperation = {
      toolName: 'edit',
      oldString: 'before',
      newString: 'after',
      additions: 1,
      deletions: 1,
      lineStart: 3,
      lineEnd: 4,
    };

    expect(getProcessedOperationKeys('/repo/a.ts', [operation])).toEqual([
      'fp:/repo/a.ts\u0000edit\u0000before\u0000after\u00003\u00004',
    ]);
  });


  it('recomputes status after filtering processed added operation from same file', () => {
    const writeOperation: EditOperation = {
      toolName: 'write',
      oldString: '',
      newString: 'initial',
      additions: 1,
      deletions: 0,
      operationId: 'op-write',
    };
    const editOperation: EditOperation = {
      toolName: 'edit',
      oldString: 'initial',
      newString: 'changed',
      additions: 1,
      deletions: 1,
      operationId: 'op-edit',
    };
    const fileChange = {
      filePath: '/repo/a.ts',
      fileName: 'a.ts',
      status: 'A' as const,
      additions: 2,
      deletions: 1,
      operations: [writeOperation, editOperation],
    };

    const filtered = filterProcessedFileChanges([fileChange], getProcessedOperationKeys('/repo/a.ts', [writeOperation]));

    expect(filtered).toHaveLength(1);
    expect(filtered[0].status).toBe('M');
    expect(filtered[0].operations).toEqual([editOperation]);
  });

  it('processed key fallback includes tool occurrence when operation id is missing', () => {
    const operation: EditOperation = {
      toolName: 'edit',
      oldString: 'before',
      newString: 'after',
      additions: 1,
      deletions: 1,
      lineStart: 3,
      lineEnd: 4,
      toolUseId: 'tool-1',
    };

    expect(getProcessedOperationKeys('/repo/a.ts', [operation])).toEqual([
      'tool:tool-1',
    ]);
  });

});

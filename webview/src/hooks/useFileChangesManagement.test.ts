import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import { useRef } from 'react';
import { useFileChangesManagement } from './useFileChangesManagement';
import type { ClaudeMessage, FileChangeSummary } from '../types';

const fileChange = (filePath: string, operationId: string): FileChangeSummary => ({
  filePath,
  fileName: filePath.split('/').pop() || filePath,
  status: 'M',
  additions: 1,
  deletions: 1,
  operations: [{ toolName: 'edit', oldString: 'before', newString: 'after', additions: 1, deletions: 1, operationId }],
});

const renderManagement = () => renderHook(() => {
  const sessionRef = useRef<string | null>('session-1');
  return useFileChangesManagement({
    currentSessionId: 'session-1',
    currentSessionIdRef: sessionRef,
    messages: [] as ClaudeMessage[],
    getContentBlocks: () => [],
    findToolResult: () => null,
  });
});

describe('useFileChangesManagement pending diff callbacks', () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.handleDiffResult;
  });

  it('does not consume ambiguous pending diff actions when requestId is missing', () => {
    const { result } = renderManagement();
    const first = fileChange('/repo/a.ts', 'op-1');
    const second = fileChange('/repo/a.ts', 'op-2');

    act(() => {
      result.current.registerPendingFileChangeAction(first);
      result.current.registerPendingFileChangeAction(second);
    });

    act(() => {
      window.handleDiffResult?.(JSON.stringify({ filePath: '/repo/a.ts', action: 'APPLY' }));
    });

    expect(result.current.processedOperationKeys).toEqual([]);
  });
});

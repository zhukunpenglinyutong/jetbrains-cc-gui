import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { ClaudeMessage, ToolResultBlock } from '../types';
import type { FileChangeSummary } from '../types/fileChanges';

export interface UseFileChangesManagementOptions {
  currentSessionId: string | null;
  currentSessionIdRef: RefObject<string | null>;
  currentFileChangesRef: RefObject<Map<string, FileChangeSummary>>;
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => any[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
}

export interface FileChange {
  filePath: string;
  [key: string]: any;
}

/**
 * Manages file change tracking: processedFiles, baseMessageIndex,
 * undo/discard/keep handlers, diff result callbacks, and session state restore.
 */
export function useFileChangesManagement({
  currentSessionId,
  currentSessionIdRef,
  currentFileChangesRef,
  messages,
}: UseFileChangesManagementOptions) {
  // List of processed tool_use ids (filtered from fileChanges after Apply/Reject, persisted to localStorage)
  const [processedOperationIds, setProcessedOperationIds] = useState<string[]>([]);
  // Base message index (for Keep All feature, only counts changes after this index)
  const [baseMessageIndex, setBaseMessageIndex] = useState(0);

  const addOperationIdsToProcessed = useCallback((operationIds: string[]) => {
    if (operationIds.length === 0) return;

    setProcessedOperationIds(prev => {
      const existing = new Set(prev);
      let changed = false;
      for (const operationId of operationIds) {
        if (!operationId || existing.has(operationId)) continue;
        existing.add(operationId);
        changed = true;
      }
      if (!changed) return prev;

      const next = Array.from(existing);
      const sessionId = currentSessionIdRef.current;
      if (sessionId) {
        try {
          localStorage.setItem(
            `processed-operation-ids-${sessionId}`,
            JSON.stringify(next)
          );
        } catch (e) {
          console.error('Failed to persist processed operation ids:', e);
        }
      }
      return next;
    });
  }, [currentSessionIdRef]);

  const getOperationIdsForFile = useCallback((filePath: string): string[] => {
    // Try exact match first, then normalized (forward-slash) match.
    // Java sends paths with forward slashes, but tool_use inputs from the AI
    // may use backslashes on Windows, causing a key mismatch.
    const fileChange = currentFileChangesRef.current.get(filePath)
      ?? currentFileChangesRef.current.get(filePath.replace(/\//g, '\\'))
      ?? currentFileChangesRef.current.get(filePath.replace(/\\/g, '/'));
    if (!fileChange) return [];
    return fileChange.operations.map(op => op.operationId).filter(Boolean);
  }, [currentFileChangesRef]);

  // Callback after file undo success (triggered from StatusPanel)
  const handleUndoFile = useCallback((filePath: string) => {
    addOperationIdsToProcessed(getOperationIdsForFile(filePath));
  }, [addOperationIdsToProcessed, getOperationIdsForFile]);

  // Callback after batch undo success (Discard All)
  const handleDiscardAll = useCallback((filteredFileChanges: FileChange[]) => {
    const operationIds = filteredFileChanges.flatMap(fc =>
      Array.isArray(fc.operations) ? fc.operations.map(op => op.operationId).filter(Boolean) : []
    );
    addOperationIdsToProcessed(operationIds);
  }, [addOperationIdsToProcessed]);

  // Callback for Keep All - set current changes as the new baseline
  const handleKeepAll = useCallback(() => {
    const newBaseIndex = messages.length;
    setBaseMessageIndex(newBaseIndex);
    setProcessedOperationIds([]);

    if (currentSessionId) {
      try {
        localStorage.setItem(`keep-all-base-${currentSessionId}`, String(newBaseIndex));
        localStorage.removeItem(`processed-operation-ids-${currentSessionId}`);
        localStorage.removeItem(`processed-files-${currentSessionId}`);
      } catch (e) {
        console.error('Failed to persist Keep All state:', e);
      }
    }
  }, [messages.length, currentSessionId]);

  // Register window callbacks for editable diff operations from Java backend
  useEffect(() => {
    // Handle remove file from edits list (legacy callback)
    window.handleRemoveFileFromEdits = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        const filePath = data.filePath;
        if (filePath) {
          addOperationIdsToProcessed(getOperationIdsForFile(filePath));
        }
      } catch {
        // JSON parse failed, ignore
      }
    };

    // Handle interactive diff result (Apply/Reject from the new interactive diff view)
    window.handleDiffResult = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        const { filePath, action, error } = data;

        if (error) {
          console.error('[InteractiveDiff] Error:', error);
          return;
        }

        if (action === 'APPLY' || action === 'REJECT') {
          addOperationIdsToProcessed(getOperationIdsForFile(filePath));
          console.log(`[InteractiveDiff] ${action} changes to:`, filePath);
        }
      } catch {
        // JSON parse failed, ignore
      }
    };

    return () => {
      delete window.handleRemoveFileFromEdits;
      delete window.handleDiffResult;
    };
  }, [addOperationIdsToProcessed, getOperationIdsForFile]);

  // Restore/reset state on session switch
  useEffect(() => {
    setProcessedOperationIds([]);

    if (!currentSessionId) {
      setBaseMessageIndex(0);
      return;
    }

    // Cleanup old localStorage entries to prevent infinite growth
    const MAX_STORED_SESSIONS = 50;
    try {
      const keysToCheck = Object.keys(localStorage)
        .filter(k =>
          k.startsWith('processed-files-')
          || k.startsWith('processed-operation-ids-')
          || k.startsWith('keep-all-base-')
        );
      if (keysToCheck.length > MAX_STORED_SESSIONS) {
        const toRemove = keysToCheck.slice(0, keysToCheck.length - MAX_STORED_SESSIONS);
        toRemove.forEach(k => localStorage.removeItem(k));
      }
    } catch {
      // Ignore cleanup errors
    }

    // Restore processed operation ids from localStorage
    try {
      const savedProcessedOperationIds = localStorage.getItem(
        `processed-operation-ids-${currentSessionId}`
      );
      if (savedProcessedOperationIds) {
        const operationIds = JSON.parse(savedProcessedOperationIds);
        if (Array.isArray(operationIds)) {
          setProcessedOperationIds(operationIds.filter((value): value is string => typeof value === 'string'));
        }
      }
    } catch (e) {
      console.error('Failed to load processed operation ids:', e);
    }

    // Restore Keep All base index
    try {
      const savedBaseIndex = localStorage.getItem(`keep-all-base-${currentSessionId}`);
      if (savedBaseIndex) {
        const index = parseInt(savedBaseIndex, 10);
        if (!isNaN(index) && index >= 0) {
          setBaseMessageIndex(index);
          return;
        }
      }
    } catch (e) {
      console.error('Failed to load Keep All state:', e);
    }

    setBaseMessageIndex(0);
  }, [currentSessionId]);

  return {
    processedOperationIds,
    baseMessageIndex,
    handleUndoFile,
    handleDiscardAll,
    handleKeepAll,
  };
}

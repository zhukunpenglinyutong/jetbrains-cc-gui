import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ClaudeMessage, ToolResultBlock } from '../types';
import { debugLog } from '../utils/debug';
import { clearLedgerMeta } from '../utils/sessionFileLedger';

export interface UseFileChangesManagementOptions {
  currentSessionId: string | null;
  currentSessionIdRef: RefObject<string | null>;
  messages: ClaudeMessage[];
  currentProvider?: string;
  fileChangesRef?: RefObject<FileChange[]>;
  getContentBlocks: (message: ClaudeMessage) => any[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
}

export interface FileChange {
  filePath: string;
  [key: string]: any;
}

function readReviewCheckpoint(storageKey: string): string[] {
  try {
    const entries = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(entries) && entries.every(entry => typeof entry === 'string') ? entries : [];
  } catch {
    // An unreadable checkpoint cannot prove that an operation was reviewed.
    return [];
  }
}

/**
 * Manages file change tracking: processedFiles, baseMessageIndex,
 * undo/discard/keep handlers, diff result callbacks, and session state restore.
 */
export function useFileChangesManagement({
  currentSessionId,
  currentSessionIdRef,
  messages,
  currentProvider = 'claude',
  fileChangesRef,
}: UseFileChangesManagementOptions) {
  // List of processed file paths (filtered from fileChanges after Apply/Reject, persisted to localStorage)
  const [processedFiles, setProcessedFiles] = useState<string[]>([]);
  // Base message index (for Keep All feature, only counts changes after this index)
  const [baseMessageIndex, setBaseMessageIndex] = useState(0);
  const [ignoredLedgerKeys, setIgnoredLedgerKeys] = useState<string[]>([]);
  const ignoredKeysRef = useRef<string[]>([]);
  const reviewChanges = useCallback((files: FileChange[], sessionId: string | null = currentSessionId) => {
    const keys = files.flatMap(file => (file.operations ?? []).map((op: { ledgerKey?: string }) => op.ledgerKey).filter(Boolean));
    const targetsCurrent = currentProvider === 'codex' && sessionId === currentSessionId;
    const previous = targetsCurrent ? ignoredKeysRef.current
      : sessionId ? readReviewCheckpoint(`codex-reviewed-edits-${sessionId}`) : [];
    const next = [...new Set<string>([...previous, ...keys])];
    if (targetsCurrent) {
      ignoredKeysRef.current = next;
      setIgnoredLedgerKeys(next);
    }
    if (sessionId) {
      try { localStorage.setItem(`codex-reviewed-edits-${sessionId}`, JSON.stringify(next)); } catch { /* Private storage. */ }
    }
  }, [currentProvider, currentSessionId]);

  // Ref to always hold the latest messages array, avoiding stale closure issues
  // in handleKeepAll when messages.length changes between renders.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Ref to always hold the latest processedFiles list, so handlers can compute
  // and persist the next list outside of the state updater.
  const processedFilesRef = useRef(processedFiles);
  useEffect(() => {
    processedFilesRef.current = processedFiles;
  }, [processedFiles]);

  // Callback after file undo success (triggered from StatusPanel)
  const handleUndoFile = useCallback((filePath: string, reviewedKeys?: string[], origin?: {
    sessionId: string | null; provider: string;
  }) => {
    const sessionId = origin ? origin.sessionId : currentSessionId;
    const provider = origin?.provider ?? currentProvider;
    const targetsCurrent = sessionId === currentSessionId && provider === currentProvider;
    if (provider === 'codex') {
      reviewChanges(reviewedKeys ? [{ filePath, operations: reviewedKeys.map(ledgerKey => ({ ledgerKey })) }]
        : targetsCurrent ? (fileChangesRef?.current ?? []).filter(file => file.filePath === filePath) : [], sessionId);
      return;
    }
    const prev = targetsCurrent ? processedFilesRef.current
      : sessionId ? readReviewCheckpoint(`processed-files-${sessionId}`) : [];
    if (prev.includes(filePath)) return;
    const newList = [...prev, filePath];

    if (targetsCurrent) {
      processedFilesRef.current = newList;
      setProcessedFiles(newList);
    }

    // Persist to localStorage
    if (sessionId) {
      try {
        localStorage.setItem(
          `processed-files-${sessionId}`,
          JSON.stringify(newList)
        );
      } catch (e) {
        console.error('Failed to persist processed files:', e);
      }
    }
  }, [currentSessionId, currentProvider, fileChangesRef, reviewChanges]);

  // Helper to add a file to the processed list with localStorage persistence
  const addFileToProcessed = useCallback((filePath: string) => {
    if (currentProvider === 'codex') {
      reviewChanges((fileChangesRef?.current ?? []).filter(file => file.filePath === filePath));
      return;
    }
    const prev = processedFilesRef.current;
    if (prev.includes(filePath)) return;
    const newList = [...prev, filePath];

    processedFilesRef.current = newList;
    setProcessedFiles(newList);

    const sessionId = currentSessionIdRef.current;
    if (sessionId) {
      try {
        localStorage.setItem(
          `processed-files-${sessionId}`,
          JSON.stringify(newList)
        );
      } catch (e) {
        console.error('Failed to persist processed files:', e);
      }
    }
  }, [currentSessionIdRef, currentProvider, fileChangesRef, reviewChanges]);

  // Callback after batch undo success (Discard All)
  const handleDiscardAll = useCallback((filteredFileChanges: FileChange[]) => {
    if (currentProvider === 'codex') { reviewChanges(filteredFileChanges); return; }
    const prev = processedFilesRef.current;
    const filesToAdd = filteredFileChanges.map(fc => fc.filePath);
    const newList = [...prev, ...filesToAdd.filter(f => !prev.includes(f))];

    processedFilesRef.current = newList;
    setProcessedFiles(newList);

    if (currentSessionId) {
      try {
        localStorage.setItem(
          `processed-files-${currentSessionId}`,
          JSON.stringify(newList)
        );
      } catch (e) {
        console.error('Failed to persist processed files:', e);
      }
    }
  }, [currentSessionId, currentProvider, reviewChanges]);

  // Callback for Keep All - set current changes as the new baseline (ledger rebuilds from index)
  const handleKeepAll = useCallback(() => {
    if (currentProvider === 'codex') { reviewChanges(fileChangesRef?.current ?? []); return; }
    // Use ref to get the latest messages.length, avoiding stale closure issues
    const newBaseIndex = messagesRef.current.length;
    setBaseMessageIndex(newBaseIndex);
    processedFilesRef.current = [];
    setProcessedFiles([]);

    if (currentSessionId) {
      try {
        localStorage.setItem(`keep-all-base-${currentSessionId}`, String(newBaseIndex));
        localStorage.removeItem(`processed-files-${currentSessionId}`);
        clearLedgerMeta(currentSessionId);
      } catch (e) {
        console.error('Failed to persist Keep All state:', e);
      }
    }
  }, [currentSessionId, currentProvider, fileChangesRef, reviewChanges]);

  // Register window callbacks for editable diff operations from Java backend
  useEffect(() => {
    // Handle remove file from edits list (legacy callback)
    window.handleRemoveFileFromEdits = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        const filePath = data.filePath;
        if (filePath) {
          addFileToProcessed(filePath);
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
          if (Object.prototype.hasOwnProperty.call(data, 'sessionId')) {
            handleUndoFile(filePath, data.ledgerKeys, { sessionId: data.sessionId, provider: data.provider });
          } else {
            addFileToProcessed(filePath);
          }
          debugLog(`[InteractiveDiff] ${action} changes to:`, filePath);
        }
      } catch {
        // JSON parse failed, ignore
      }
    };

    return () => {
      delete window.handleRemoveFileFromEdits;
      delete window.handleDiffResult;
    };
  }, [addFileToProcessed, handleUndoFile]);

  // Restore/reset state on session switch
  useEffect(() => {
    processedFilesRef.current = [];
    setProcessedFiles([]);
    ignoredKeysRef.current = [];
    setIgnoredLedgerKeys([]);

    if (!currentSessionId) {
      setBaseMessageIndex(0);
      return;
    }
    if (currentProvider === 'codex') {
      setBaseMessageIndex(0);
      const keys = readReviewCheckpoint(`codex-reviewed-edits-${currentSessionId}`);
      ignoredKeysRef.current = keys;
      setIgnoredLedgerKeys(keys);
      return;
    }

    // Cleanup old localStorage entries to prevent infinite growth
    const MAX_STORED_SESSIONS = 50;
    try {
      const keysToCheck = Object.keys(localStorage)
        .filter(k => k.startsWith('processed-files-') || k.startsWith('keep-all-base-'));
      if (keysToCheck.length > MAX_STORED_SESSIONS) {
        const toRemove = keysToCheck.slice(0, keysToCheck.length - MAX_STORED_SESSIONS);
        toRemove.forEach(k => localStorage.removeItem(k));
      }
    } catch {
      // Ignore cleanup errors
    }

    // Restore processed files from localStorage
    try {
      const savedProcessedFiles = localStorage.getItem(
        `processed-files-${currentSessionId}`
      );
      if (savedProcessedFiles) {
        const files = JSON.parse(savedProcessedFiles);
        if (Array.isArray(files)) {
          processedFilesRef.current = files;
          setProcessedFiles(files);
        }
      }
    } catch (e) {
      console.error('Failed to load processed files:', e);
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
  }, [currentSessionId, currentProvider]);

  return {
    processedFiles,
    baseMessageIndex,
    ignoredLedgerKeys,
    handleUndoFile,
    handleDiscardAll,
    handleKeepAll,
  };
}

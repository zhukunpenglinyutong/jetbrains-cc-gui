import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ClaudeMessage, ToolResultBlock } from '../types';
import { debugLog } from '../utils/debug';
import { editOperationKey } from './useFileChanges';

/** localStorage prefix for the edit operations acknowledged via Keep All (per session). */
const CONFIRMED_EDITS_PREFIX = 'confirmed-edits-';
/**
 * Superseded Keep All baselines from earlier releases. Both were position-based
 * (a raw array index, then a message identity) and cannot be mapped onto a
 * rebuilt transcript, so they are dropped rather than read back.
 */
const LEGACY_BASELINE_PREFIXES = ['keep-all-base-', 'keep-all-anchor-'] as const;

/** Cap on remembered operation fingerprints per session (oldest are dropped). */
const MAX_CONFIRMED_EDITS = 1000;

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

/**
 * Read a persisted string list from localStorage, ignoring anything malformed.
 * Shared by the codex review checkpoint and the Claude Keep All acknowledgements
 * — an unreadable list cannot prove that an operation was reviewed, so it reads
 * back empty.
 */
function readReviewCheckpoint(storageKey: string): string[] {
  try {
    const entries = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(entries) && entries.every(entry => typeof entry === 'string') ? entries : [];
  } catch {
    return [];
  }
}

/** Merge two acknowledgement lists, keeping order and dropping duplicates. */
function mergeAcknowledged(existing: string[], added: string[]): string[] {
  const merged = new Set(existing);
  for (const key of added) {
    merged.add(key);
  }
  let next = Array.from(merged);
  if (next.length > MAX_CONFIRMED_EDITS) {
    next = next.slice(next.length - MAX_CONFIRMED_EDITS);
  }
  return next;
}

/**
 * Drop the per-file Apply/Reject marks for a session. Keep All acknowledges the
 * whole session so far, so those marks must go with it — the restore effect
 * would otherwise bring them back on the next load and hide later edits to the
 * same file behind a file the user once accepted.
 */
function clearPersistedProcessedFiles(sessionId: string | null): void {
  if (!sessionId) return;
  try {
    localStorage.removeItem(`processed-files-${sessionId}`);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Manages file change tracking: processedFiles, the Keep All acknowledgements,
 * undo/discard handlers, diff result callbacks, and session state restore.
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
  // Ledger keys the user already reviewed (codex), dropped from the ledger before it is built
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

  // Fingerprints of the edit operations the user acknowledged via Keep All.
  //
  // Keep All marks a moment in time, and the only thing that survives a session
  // reload intact is the operations themselves: the transcript is rebuilt from
  // the backend snapshot and is not isomorphic to the live-assembled array
  // (history can carry messages the live array did not have, after the point
  // that was "last" at Keep All time), so neither an array index nor a message
  // identity can delimit it.
  const [confirmedEdits, setConfirmedEdits] = useState<string[]>([]);

  // Ref to always hold the latest transcript, so the pending flush in the restore
  // effect can tell an id landing on its own session apart from a switch to a
  // different one.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Ref to always hold the latest acknowledged list, so handlers can compute and
  // persist the next list outside of the state updater.
  const confirmedEditsRef = useRef(confirmedEdits);
  // Acknowledgements made before the session had an id to persist them under.
  const pendingConfirmedEditsRef = useRef<string[] | null>(null);
  const previousSessionIdRef = useRef<string | null>(currentSessionId);

  const confirmedEditKeys = useMemo(() => new Set(confirmedEdits), [confirmedEdits]);

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

  // Callback for Keep All - acknowledge the given operations so the ledger
  // rebuilds without them (the remaining changes start from a fresh baseline).
  const confirmEdits = useCallback((operationKeys: string[]) => {
    processedFilesRef.current = [];
    setProcessedFiles([]);
    // Keep All acknowledges the session's work as a whole, so the per-file
    // Apply/Reject marks go with it. Cleared before any early return below:
    // a Keep All with nothing new to acknowledge still clears those marks.
    clearPersistedProcessedFiles(currentSessionIdRef.current);

    if (operationKeys.length === 0) return;

    const next = mergeAcknowledged(confirmedEditsRef.current, operationKeys);
    confirmedEditsRef.current = next;
    setConfirmedEdits(next);

    // Read the id from the ref: a freshly created session receives its id from
    // the backend asynchronously, so the state value can still be stale here.
    const sessionId = currentSessionIdRef.current;
    if (sessionId) {
      try {
        localStorage.setItem(
          `${CONFIRMED_EDITS_PREFIX}${sessionId}`,
          JSON.stringify(next)
        );
      } catch (e) {
        console.error('Failed to persist Keep All state:', e);
      }
      pendingConfirmedEditsRef.current = null;
      return;
    }
    // No id yet (a new session before the backend reports one). Hold the list so
    // the acknowledgement is not lost when the session is reopened from history.
    pendingConfirmedEditsRef.current = next;
  }, [currentSessionIdRef]);

  // Callback for Keep All - acknowledge everything the ledger currently holds, so
  // the ledger rebuilds from whatever comes after. Codex records the ledger keys
  // it reviewed; Claude records one content fingerprint per operation, because a
  // transcript position cannot survive a session reload (see editOperationKey).
  // Reads fileChangesRef (the unfiltered ledger) so files already handled one by
  // one via Apply/Reject are acknowledged too.
  const handleKeepAll = useCallback(() => {
    const files = fileChangesRef?.current ?? [];
    if (currentProvider === 'codex') { reviewChanges(files); return; }
    const keys: string[] = [];
    for (const file of files) {
      for (const op of file.operations ?? []) {
        keys.push(editOperationKey({
          filePath: file.filePath,
          toolName: op.toolName,
          oldString: op.oldString,
          newString: op.newString,
          replaceAll: op.replaceAll,
        }));
      }
    }
    confirmEdits(keys);
  }, [currentProvider, fileChangesRef, reviewChanges, confirmEdits]);

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
    const previousSessionId = previousSessionIdRef.current;
    previousSessionIdRef.current = currentSessionId;

    // An id arriving where there was none means this session just became
    // addressable — flush whatever was acknowledged while it was not. But
    // `!previousSessionId` cannot tell "this session just got its id" from "the
    // user switched to some existing session": writing on the latter would wipe
    // that session's own acknowledgements. Switching always empties the
    // transcript first (beginSessionTransition), so a non-empty transcript is
    // what marks this as the same session. If in doubt the pending list is
    // dropped — losing one Keep All beats corrupting another session's state.
    const pending = pendingConfirmedEditsRef.current;
    pendingConfirmedEditsRef.current = null;
    const pendingBelongsToThisSession = messagesRef.current.length > 0;
    if (pending && currentSessionId && !previousSessionId && pendingBelongsToThisSession) {
      try {
        const existing = readReviewCheckpoint(`${CONFIRMED_EDITS_PREFIX}${currentSessionId}`);
        // Merge rather than overwrite, so a wrong guess cannot erase what is
        // already recorded for this session.
        localStorage.setItem(
          `${CONFIRMED_EDITS_PREFIX}${currentSessionId}`,
          JSON.stringify(mergeAcknowledged(existing, pending))
        );
        // There was no id to clear these against when the user pressed Keep All.
        clearPersistedProcessedFiles(currentSessionId);
      } catch (e) {
        console.error('Failed to persist Keep All state:', e);
      }
    }

    processedFilesRef.current = [];
    setProcessedFiles([]);
    ignoredKeysRef.current = [];
    setIgnoredLedgerKeys([]);
    confirmedEditsRef.current = [];
    setConfirmedEdits([]);

    if (!currentSessionId) {
      return;
    }
    if (currentProvider === 'codex') {
      const keys = readReviewCheckpoint(`codex-reviewed-edits-${currentSessionId}`);
      ignoredKeysRef.current = keys;
      setIgnoredLedgerKeys(keys);
      return;
    }

    // Cleanup old localStorage entries to prevent infinite growth
    const MAX_STORED_SESSIONS = 50;
    try {
      const keysToCheck = Object.keys(localStorage).filter((key) => (
        key.startsWith('processed-files-')
        || key.startsWith(CONFIRMED_EDITS_PREFIX)
        || LEGACY_BASELINE_PREFIXES.some((prefix) => key.startsWith(prefix))
      ));
      if (keysToCheck.length > MAX_STORED_SESSIONS) {
        const toRemove = keysToCheck.slice(0, keysToCheck.length - MAX_STORED_SESSIONS);
        toRemove.forEach((key) => localStorage.removeItem(key));
      }
    } catch {
      // Ignore cleanup errors
    }

    // Drop superseded position-based baselines: they cannot be mapped onto the
    // rebuilt transcript and are never read back.
    LEGACY_BASELINE_PREFIXES.forEach((prefix) => {
      try {
        localStorage.removeItem(`${prefix}${currentSessionId}`);
      } catch {
        // Ignore storage errors
      }
    });

    const processed = readReviewCheckpoint(`processed-files-${currentSessionId}`);
    if (processed.length > 0) {
      processedFilesRef.current = processed;
      setProcessedFiles(processed);
    }

    const keys = readReviewCheckpoint(`${CONFIRMED_EDITS_PREFIX}${currentSessionId}`);
    if (keys.length > 0) {
      confirmedEditsRef.current = keys;
      setConfirmedEdits(keys);
    }
  }, [currentSessionId, currentProvider]);

  return {
    processedFiles,
    ignoredLedgerKeys,
    confirmedEditKeys,
    handleUndoFile,
    handleDiscardAll,
    handleKeepAll,
    confirmEdits,
  };
}

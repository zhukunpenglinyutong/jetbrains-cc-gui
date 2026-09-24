import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ClaudeMessage, ToolResultBlock } from '../types';
import { debugLog } from '../utils/debug';

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
  getContentBlocks: (message: ClaudeMessage) => any[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
}

export interface FileChange {
  filePath: string;
  [key: string]: any;
}

/** Read a persisted string list, ignoring anything malformed. */
function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
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
}: UseFileChangesManagementOptions) {
  // List of processed file paths (filtered from fileChanges after Apply/Reject, persisted to localStorage)
  const [processedFiles, setProcessedFiles] = useState<string[]>([]);
  // Fingerprints of the edit operations the user acknowledged via Keep All.
  //
  // Keep All marks a moment in time, and the only thing that survives a session
  // reload intact is the operations themselves: the transcript is rebuilt from
  // the backend snapshot and is not isomorphic to the live-assembled array
  // (history can carry messages the live array did not have, after the point
  // that was "last" at Keep All time), so neither an array index nor a message
  // identity can delimit it.
  const [confirmedEdits, setConfirmedEdits] = useState<string[]>([]);

  // Ref to always hold the latest acknowledged list, so handlers can compute and
  // persist the next list outside of the state updater.
  const confirmedEditsRef = useRef(confirmedEdits);
  // Acknowledgements made before the session had an id to persist them under.
  const pendingConfirmedEditsRef = useRef<string[] | null>(null);
  const previousSessionIdRef = useRef<string | null>(currentSessionId);
  // Latest transcript, so the pending flush below can tell an id landing on its
  // own session apart from a switch to a different one (see that flush).
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const confirmedEditKeys = useMemo(() => new Set(confirmedEdits), [confirmedEdits]);

  // Ref to always hold the latest processedFiles list, so handlers can compute
  // and persist the next list outside of the state updater.
  const processedFilesRef = useRef(processedFiles);
  useEffect(() => {
    processedFilesRef.current = processedFiles;
  }, [processedFiles]);

  // Callback after file undo success (triggered from StatusPanel)
  const handleUndoFile = useCallback((filePath: string) => {
    const prev = processedFilesRef.current;
    if (prev.includes(filePath)) return;
    const newList = [...prev, filePath];

    processedFilesRef.current = newList;
    setProcessedFiles(newList);

    // Persist to localStorage
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
  }, [currentSessionId]);

  // Helper to add a file to the processed list with localStorage persistence
  const addFileToProcessed = useCallback((filePath: string) => {
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
  }, [currentSessionIdRef]);

  // Callback after batch undo success (Discard All)
  const handleDiscardAll = useCallback((filteredFileChanges: FileChange[]) => {
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
  }, [currentSessionId]);

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
          addFileToProcessed(filePath);
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
  }, [addFileToProcessed]);

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
        const existing = parseStringList(
          localStorage.getItem(`${CONFIRMED_EDITS_PREFIX}${currentSessionId}`)
        );
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
    confirmedEditsRef.current = [];
    setConfirmedEdits([]);

    if (!currentSessionId) {
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

    try {
      const savedProcessedFiles = localStorage.getItem(`processed-files-${currentSessionId}`);
      if (savedProcessedFiles) {
        const files = parseStringList(savedProcessedFiles);
        processedFilesRef.current = files;
        setProcessedFiles(files);
      }
    } catch (e) {
      console.error('Failed to load processed files:', e);
    }

    try {
      const savedConfirmedEdits = localStorage.getItem(
        `${CONFIRMED_EDITS_PREFIX}${currentSessionId}`
      );
      if (savedConfirmedEdits) {
        const keys = parseStringList(savedConfirmedEdits);
        confirmedEditsRef.current = keys;
        setConfirmedEdits(keys);
      }
    } catch (e) {
      console.error('Failed to load Keep All state:', e);
    }
  }, [currentSessionId]);

  return {
    processedFiles,
    confirmedEditKeys,
    handleUndoFile,
    handleDiscardAll,
    confirmEdits,
  };
}

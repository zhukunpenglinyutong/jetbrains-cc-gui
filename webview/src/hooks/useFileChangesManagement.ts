import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  ClaudeMessage,
  EditOperation,
  FileChangeSummary,
  ToolResultBlock,
} from "../types";
import { getProcessedOperationKeys } from "../utils/fileChangeProcessing";
import { debugLog } from "../utils/debug";

export interface UseFileChangesManagementOptions {
  currentSessionId: string | null;
  currentSessionIdRef: RefObject<string | null>;
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => any[];
  findToolResult: (
    toolUseId?: string,
    messageIndex?: number,
  ) => ToolResultBlock | null;
}

export type FileChange = FileChangeSummary;

const createRequestId = (counter: number): string => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `file-change-${crypto.randomUUID()}`;
  }
  return `file-change-${Date.now()}-${counter}`;
};

const sameStringArray = (left: string[], right: string[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

export function useFileChangesManagement({
  currentSessionId,
  currentSessionIdRef,
  messages,
}: UseFileChangesManagementOptions) {
  const [processedOperationKeys, setProcessedOperationKeys] = useState<
    string[]
  >([]);
  const [baseMessageIndex, setBaseMessageIndex] = useState(0);
  const pendingActionCounterRef = useRef(0);
  const pendingFileChangeActionsRef = useRef(new Map<string, FileChange>());
  const loadedSessionRef = useRef<string | null>(null);

  const persistProcessedOperationKeys = useCallback(
    (keys: string[]) => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return;
      try {
        localStorage.setItem(
          `processed-edit-keys-${sessionId}`,
          JSON.stringify(keys),
        );
        localStorage.removeItem(`processed-files-${sessionId}`);
      } catch (error) {
        console.error("Failed to persist processed edit keys:", error);
      }
    },
    [currentSessionIdRef],
  );

  useEffect(() => {
    if (loadedSessionRef.current !== currentSessionId) {
      return;
    }
    persistProcessedOperationKeys(processedOperationKeys);
  }, [currentSessionId, persistProcessedOperationKeys, processedOperationKeys]);

  const addOperationsToProcessed = useCallback(
    (filePath: string, operations?: EditOperation[]) => {
      if (!filePath || !Array.isArray(operations) || operations.length === 0) {
        return;
      }
      const keysToAdd = getProcessedOperationKeys(filePath, operations);
      if (keysToAdd.length === 0) {
        return;
      }
      setProcessedOperationKeys((prev) => {
        const next = [...prev];
        keysToAdd.forEach((key) => {
          if (!next.includes(key)) {
            next.push(key);
          }
        });
        return sameStringArray(prev, next) ? prev : next;
      });
    },
    [],
  );

  const handleUndoFile = useCallback(
    (filePath: string, operations?: EditOperation[]) => {
      addOperationsToProcessed(filePath, operations);
    },
    [addOperationsToProcessed],
  );

  const registerPendingFileChangeAction = useCallback(
    (fileChange: FileChangeSummary): string => {
      pendingActionCounterRef.current += 1;
      const requestId = createRequestId(pendingActionCounterRef.current);
      pendingFileChangeActionsRef.current.set(requestId, fileChange);
      return requestId;
    },
    [],
  );

  const clearPendingFileChangeAction = useCallback((requestId?: string) => {
    if (requestId) {
      pendingFileChangeActionsRef.current.delete(requestId);
    }
  }, []);

  const consumePendingFileChangeAction = useCallback(
    (filePath?: string, requestId?: string): FileChange | undefined => {
      if (requestId) {
        const fileChange = pendingFileChangeActionsRef.current.get(requestId);
        pendingFileChangeActionsRef.current.delete(requestId);
        if (!fileChange) {
          console.warn(
            "[InteractiveDiff] No pending file change action for request id:",
            requestId,
          );
        }
        return fileChange;
      }
      if (!filePath) {
        return undefined;
      }
      const matches = Array.from(
        pendingFileChangeActionsRef.current.entries(),
      ).filter(([, value]) => value.filePath === filePath);
      if (matches.length === 0) {
        console.warn(
          "[InteractiveDiff] No pending file change action for file:",
          filePath,
        );
        return undefined;
      }
      if (matches.length > 1) {
        matches.forEach(([key]) =>
          pendingFileChangeActionsRef.current.delete(key),
        );
        console.warn(
          "[InteractiveDiff] Ambiguous pending file change actions cleared for file:",
          filePath,
        );
        return undefined;
      }
      const [key, value] = matches[0];
      pendingFileChangeActionsRef.current.delete(key);
      return value;
    },
    [],
  );

  const handleKeepAll = useCallback(
    (_currentFileChanges: FileChange[] = []) => {
      const newBaseIndex = messages.length;

      setBaseMessageIndex(newBaseIndex);
      setProcessedOperationKeys([]);
      pendingFileChangeActionsRef.current.clear();

      if (currentSessionId) {
        try {
          localStorage.setItem(
            `keep-all-base-${currentSessionId}`,
            String(newBaseIndex),
          );
          localStorage.removeItem(`keep-all-edit-sequence-${currentSessionId}`);
          localStorage.removeItem(`processed-edit-keys-${currentSessionId}`);
          localStorage.removeItem(`processed-files-${currentSessionId}`);
        } catch (error) {
          console.error("Failed to persist Keep All state:", error);
        }
      }
    },
    [messages.length, currentSessionId],
  );

  useEffect(() => {
    window.handleRemoveFileFromEdits = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        const fileChange = consumePendingFileChangeAction(
          data.filePath,
          data.requestId,
        );
        if (fileChange) {
          addOperationsToProcessed(fileChange.filePath, fileChange.operations);
        }
      } catch (error) {
        console.error("Failed to handle remove file from edits:", error);
      }
    };

    window.handleDiffResult = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        const { filePath, action, error, requestId } = data;

        if (error) {
          console.error("[InteractiveDiff] Error:", error);
          consumePendingFileChangeAction(filePath, requestId);
          return;
        }

        if (action === "APPLY" || action === "REJECT") {
          const fileChange = consumePendingFileChangeAction(
            filePath,
            requestId,
          );
          if (fileChange) {
            addOperationsToProcessed(
              fileChange.filePath,
              fileChange.operations,
            );
          }
          debugLog(`[InteractiveDiff] ${action} changes to:`, filePath);
        } else if (action === "ERROR" || action === "DISMISS") {
          consumePendingFileChangeAction(filePath, requestId);
        }
      } catch (error) {
        console.error("Failed to handle diff result:", error);
      }
    };

    return () => {
      delete window.handleRemoveFileFromEdits;
      delete window.handleDiffResult;
    };
  }, [addOperationsToProcessed, consumePendingFileChangeAction]);

  useEffect(() => {
    loadedSessionRef.current = null;
    setProcessedOperationKeys([]);
    pendingFileChangeActionsRef.current.clear();

    if (!currentSessionId) {
      setBaseMessageIndex(0);
      loadedSessionRef.current = null;
      return;
    }

    setBaseMessageIndex(0);

    const MAX_STORED_SESSIONS = 50;
    try {
      const keysToCheck = Object.keys(localStorage).filter(
        (k) =>
          k.startsWith("processed-files-") ||
          k.startsWith("processed-edit-keys-") ||
          k.startsWith("keep-all-base-") ||
          k.startsWith("keep-all-edit-sequence-"),
      );
      if (keysToCheck.length > MAX_STORED_SESSIONS) {
        const toRemove = keysToCheck.slice(
          0,
          keysToCheck.length - MAX_STORED_SESSIONS,
        );
        toRemove.forEach((k) => localStorage.removeItem(k));
      }
    } catch (error) {
      console.warn("Failed to clean persisted file change state:", error);
    }

    try {
      const savedProcessedKeys = localStorage.getItem(
        `processed-edit-keys-${currentSessionId}`,
      );
      if (savedProcessedKeys) {
        const keys = JSON.parse(savedProcessedKeys);
        if (Array.isArray(keys)) {
          setProcessedOperationKeys(
            keys.filter((key): key is string => typeof key === "string"),
          );
        }
      }
    } catch (error) {
      console.error("Failed to load processed edit keys:", error);
    }

    try {
      const savedBaseIndex = localStorage.getItem(
        `keep-all-base-${currentSessionId}`,
      );
      if (savedBaseIndex) {
        const index = parseInt(savedBaseIndex, 10);
        if (!isNaN(index) && index >= 0) {
          setBaseMessageIndex(index);
        }
      }
    } catch (error) {
      console.error("Failed to load Keep All state:", error);
    }

    loadedSessionRef.current = currentSessionId;
  }, [currentSessionId]);

  return {
    processedOperationKeys,
    baseMessageIndex,
    handleUndoFile,
    handleKeepAll,
    registerPendingFileChangeAction,
    clearPendingFileChangeAction,
  };
}

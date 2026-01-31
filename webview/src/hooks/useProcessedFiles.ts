import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileChangeSummary } from '../types/fileChanges';

export interface UseProcessedFilesOptions {
  currentSessionId: string | null;
  messagesLength: number;
  filteredFileChanges: FileChangeSummary[];
}

export interface UseProcessedFilesReturn {
  /** List of processed file paths (Applied/Rejected) */
  processedFiles: string[];
  /** Base message index for Keep All feature */
  baseMessageIndex: number;
  /** Callback when a file is undone */
  handleUndoFile: (filePath: string) => void;
  /** Callback when all files are discarded */
  handleDiscardAll: () => void;
  /** Callback when all changes are kept */
  handleKeepAll: () => void;
  /** Ref to current session ID for use in callbacks */
  currentSessionIdRef: React.RefObject<string | null>;
}

const MAX_STORED_SESSIONS = 50;

/**
 * Hook for managing processed files state and persistence
 */
export function useProcessedFiles({
  currentSessionId,
  messagesLength,
  filteredFileChanges,
}: UseProcessedFilesOptions): UseProcessedFilesReturn {
  const [processedFiles, setProcessedFiles] = useState<string[]>([]);
  const [baseMessageIndex, setBaseMessageIndex] = useState(0);
  const currentSessionIdRef = useRef(currentSessionId);

  // Keep ref in sync
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  /**
   * Callback when a file is undone from StatusPanel
   */
  const handleUndoFile = useCallback((filePath: string) => {
    setProcessedFiles(prev => {
      if (prev.includes(filePath)) return prev;
      const newList = [...prev, filePath];

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

      return newList;
    });
  }, [currentSessionId]);

  /**
   * Callback when all files are discarded (Discard All)
   */
  const handleDiscardAll = useCallback(() => {
    setProcessedFiles(prev => {
      const filesToAdd = filteredFileChanges.map(fc => fc.filePath);
      const newList = [...prev, ...filesToAdd.filter(f => !prev.includes(f))];

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

      return newList;
    });
  }, [filteredFileChanges, currentSessionId]);

  /**
   * Callback when all changes are kept (Keep All) - sets new baseline
   */
  const handleKeepAll = useCallback(() => {
    const newBaseIndex = messagesLength;
    setBaseMessageIndex(newBaseIndex);
    setProcessedFiles([]);

    // Persist to localStorage
    if (currentSessionId) {
      try {
        localStorage.setItem(`keep-all-base-${currentSessionId}`, String(newBaseIndex));
        localStorage.removeItem(`processed-files-${currentSessionId}`);
      } catch (e) {
        console.error('Failed to persist Keep All state:', e);
      }
    }
  }, [messagesLength, currentSessionId]);

  /**
   * Restore/reset state on session change
   */
  useEffect(() => {
    setProcessedFiles([]);

    if (!currentSessionId) {
      setBaseMessageIndex(0);
      return;
    }

    // Cleanup old localStorage entries to prevent infinite growth
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
  }, [currentSessionId]);

  return {
    processedFiles,
    baseMessageIndex,
    handleUndoFile,
    handleDiscardAll,
    handleKeepAll,
    currentSessionIdRef,
  };
}

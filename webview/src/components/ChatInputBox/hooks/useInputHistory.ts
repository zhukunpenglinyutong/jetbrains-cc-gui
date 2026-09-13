/**
 * React hook for input history navigation in the chat input box.
 *
 * Storage functions are in `./inputHistoryStorage.ts`.
 * This file only contains the React hook and re-exports for backward compatibility.
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { sendToJava } from '../../../utils/bridge.js';
import {
  INVISIBLE_CHARS_RE,
  MAX_HISTORY_ITEMS,
  splitTextToFragments,
  canUseLocalStorage,
  loadHistory,
  loadCounts,
  saveHistory,
  saveTimestamps,
  cleanupCounts,
} from './inputHistoryStorage.js';

// Re-export everything from storage for backward compatibility
export {
  HISTORY_STORAGE_KEY,
  HISTORY_COUNTS_KEY,
  HISTORY_TIMESTAMPS_KEY,
  HISTORY_ENABLED_KEY,
  type HistoryItem,
  loadHistory,
  loadCounts,
  loadTimestamps,
  isHistoryCompletionEnabled,
  deleteHistoryItem,
  clearAllHistory,
  loadHistoryWithImportance,
  addHistoryItem,
  updateHistoryItem,
  clearLowImportanceHistory,
} from './inputHistoryStorage.js';

type EditableRef = RefObject<HTMLDivElement | null>;

type KeyEventLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
};

export interface UseInputHistoryOptions {
  editableRef: EditableRef;
  getTextContent: () => string;
  handleInput: (inputType?: string) => void;
}

export interface UseInputHistoryReturn {
  record: (text: string) => void;
  handleKeyDown: (e: KeyEventLike) => boolean;
}

/**
 * Provides input history navigation for the chat input box.
 *
 * Behavior:
 * - When the input is empty, `ArrowUp` cycles through previous inputs.
 * - While navigating history, `ArrowDown` moves forward; reaching the end restores the draft.
 * - Recorded history is persisted in `localStorage` and capped at `MAX_HISTORY_ITEMS`.
 */
export function useInputHistory({
  editableRef,
  getTextContent,
  handleInput,
}: UseInputHistoryOptions): UseInputHistoryReturn {
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const draftRef = useRef<string>('');

  useEffect(() => {
    historyRef.current = loadHistory();
  }, []);

  const setText = useCallback(
    (nextText: string) => {
      const el = editableRef.current;
      if (!el) return;

      try {
        el.innerText = nextText;

        // Move cursor to end
        const range = document.createRange();
        const selection = window.getSelection();
        if (selection) {
          range.selectNodeContents(el);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } catch {
        // Defensive: JCEF/IME edge cases can throw on DOM selection APIs.
      } finally {
        handleInput();
      }
    },
    [editableRef, handleInput]
  );

  const record = useCallback((text: string) => {
    const sanitized = text.replace(INVISIBLE_CHARS_RE, '');
    if (!sanitized.trim()) return;

    // Split text into fragments for fine-grained history matching
    // Returns empty array for long texts (> MAX_SPLIT_LENGTH), skipping recording
    const fragments = splitTextToFragments(sanitized);
    if (fragments.length === 0) return;

    // Batch increment usage count and save timestamps for all fragments
    if (canUseLocalStorage()) {
      try {
        let counts = loadCounts();
        for (const fragment of fragments) {
          counts[fragment] = (counts[fragment] || 0) + 1;
        }
        counts = cleanupCounts(counts);
        window.localStorage.setItem('chat-input-history-counts', JSON.stringify(counts));
        saveTimestamps(fragments);
      } catch {
        // Ignore errors
      }
    }

    const currentItems = historyRef.current;

    // Create a set of new fragments for quick lookup
    const newFragmentsSet = new Set(fragments);

    // Remove existing occurrences of any fragment to avoid duplicates
    const filteredItems = currentItems.filter(item => !newFragmentsSet.has(item));

    // Add all fragments to the end, maintaining order (fragments first, then original)
    const newItems = [...filteredItems, ...fragments].slice(-MAX_HISTORY_ITEMS);
    const persistedItems = saveHistory(newItems);
    historyRef.current = persistedItems;
    historyIndexRef.current = -1;
    draftRef.current = '';

    // Also sync to .codemoss (async)
    sendToJava('record_input_history', JSON.stringify(fragments));
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyEventLike): boolean => {
      const key = e.key;

      if (historyIndexRef.current !== -1 && key !== 'ArrowUp' && key !== 'ArrowDown') {
        historyIndexRef.current = -1;
        draftRef.current = '';
        return false;
      }

      if (key !== 'ArrowUp' && key !== 'ArrowDown') return false;
      if (e.metaKey || e.ctrlKey || e.altKey) return false;

      const items = historyRef.current;
      if (items.length === 0) return false;

      const currentText = getTextContent();
      const cleanCurrent = currentText.replace(INVISIBLE_CHARS_RE, '').trim();
      const isNavigating = historyIndexRef.current !== -1;

      // Only start history navigation when input is empty
      if (!isNavigating && cleanCurrent) return false;
      // ArrowDown only works when already navigating
      if (!isNavigating && key === 'ArrowDown') return false;

      e.preventDefault();
      e.stopPropagation();

      if (!isNavigating) {
        draftRef.current = currentText;
      }

      if (key === 'ArrowUp') {
        const nextIndex = isNavigating
          ? Math.max(0, historyIndexRef.current - 1)
          : items.length - 1;
        historyIndexRef.current = nextIndex;
        setText(items[nextIndex]);
        return true;
      }

      // ArrowDown
      if (!isNavigating) return true;
      if (historyIndexRef.current < items.length - 1) {
        historyIndexRef.current += 1;
        setText(items[historyIndexRef.current]);
        return true;
      }

      historyIndexRef.current = -1;
      setText(draftRef.current);
      draftRef.current = '';
      return true;
    },
    [getTextContent, setText]
  );

  return { record, handleKeyDown };
}

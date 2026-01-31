import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { sendToJava } from '../../../utils/bridge.js';

/** localStorage key for chat input history */
export const HISTORY_STORAGE_KEY = 'chat-input-history';
/** localStorage key for history usage counts */
export const HISTORY_COUNTS_KEY = 'chat-input-history-counts';
/** localStorage key for history completion enabled setting */
export const HISTORY_ENABLED_KEY = 'historyCompletionEnabled';

/**
 * Keep the stored history bounded to avoid unbounded localStorage growth.
 * Note: The actual limit is 200 in the backend (.codemoss)
 */
const MAX_HISTORY_ITEMS = 200;
const INVISIBLE_CHARS_RE = /[\u200B-\u200D\uFEFF]/g;

/**
 * Separator regex for splitting text into fragments
 * Includes: comma, period, semicolon, Chinese punctuation, whitespace, newlines
 */
const SEPARATORS_RE = /[,，.。;；、\s\n\r]+/;

/**
 * Maximum text length to perform fragment splitting
 * Longer texts are stored as-is without splitting
 */
const MAX_SPLIT_LENGTH = 300;

/**
 * Minimum fragment length to be recorded
 * Fragments shorter than this are ignored
 */
const MIN_FRAGMENT_LENGTH = 3;

/**
 * Split text into fragments by separators for fine-grained history matching
 *
 * Rules:
 * - If text length > MAX_SPLIT_LENGTH, return empty array (skip recording entirely)
 * - Split by separators (comma, period, semicolon, whitespace, etc.)
 * - Filter out fragments shorter than MIN_FRAGMENT_LENGTH
 * - Include the original text as well (if >= MIN_FRAGMENT_LENGTH)
 * - Deduplicate fragments
 */
function splitTextToFragments(text: string): string[] {
  const trimmed = text.trim();

  // Skip recording for long texts (e.g., code snippets)
  if (trimmed.length > MAX_SPLIT_LENGTH) {
    return [];
  }

  // Split by separators
  const rawFragments = trimmed.split(SEPARATORS_RE);

  // Filter and deduplicate
  const result = new Set<string>();

  for (const fragment of rawFragments) {
    const cleaned = fragment.trim();
    if (cleaned.length >= MIN_FRAGMENT_LENGTH) {
      result.add(cleaned);
    }
  }

  // Also include the original text if it's long enough
  if (trimmed.length >= MIN_FRAGMENT_LENGTH) {
    result.add(trimmed);
  }

  return Array.from(result);
}

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

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

function isQuotaExceededError(err: unknown): boolean {
  const domError = err as { name?: unknown; code?: unknown } | null;
  const name = typeof domError?.name === 'string' ? domError.name : '';
  const code = typeof domError?.code === 'number' ? domError.code : undefined;

  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

/**
 * Load history items from localStorage
 */
export function loadHistory(): string[] {
  if (!canUseLocalStorage()) return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * Delete a specific history item
 * Dual-write: localStorage + .codemoss
 */
export function deleteHistoryItem(item: string): void {
  // Write to localStorage (sync)
  if (canUseLocalStorage()) {
    try {
      const items = loadHistory();
      const filtered = items.filter((i) => i !== item);
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(filtered));

      // Also remove from counts
      const counts = loadCounts();
      delete counts[item];
      window.localStorage.setItem(HISTORY_COUNTS_KEY, JSON.stringify(counts));
    } catch {
      // Ignore errors
    }
  }

  // Also sync to .codemoss (async)
  sendToJava('delete_input_history_item', item);
}

/**
 * Clear all history items
 * Dual-write: localStorage + .codemoss
 */
export function clearAllHistory(): void {
  // Write to localStorage (sync)
  if (canUseLocalStorage()) {
    try {
      window.localStorage.removeItem(HISTORY_STORAGE_KEY);
      window.localStorage.removeItem(HISTORY_COUNTS_KEY);
    } catch {
      // Ignore errors
    }
  }

  // Also sync to .codemoss (async)
  sendToJava('clear_input_history', {});
}

function saveHistory(items: string[]): string[] {
  if (!canUseLocalStorage()) return items;

  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items));
    return items;
  } catch (err) {
    // If quota exceeded, drop older entries and retry, keeping the most recent.
    if (isQuotaExceededError(err)) {
      for (let startIndex = 1; startIndex < items.length; startIndex++) {
        try {
          const subset = items.slice(startIndex);
          window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(subset));
          return subset;
        } catch (retryErr) {
          if (!isQuotaExceededError(retryErr)) {
            return items;
          }
        }
      }

      // If even a single item cannot be stored, keep in-memory history only.
      return items;
    }

    return items;
  }
}

/**
 * Load usage counts from localStorage
 */
export function loadCounts(): Record<string, number> {
  if (!canUseLocalStorage()) return {};
  try {
    const raw = window.localStorage.getItem(HISTORY_COUNTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    // Validate that all values are numbers
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Check if history completion is enabled
 */
export function isHistoryCompletionEnabled(): boolean {
  if (!canUseLocalStorage()) return true;
  try {
    const value = window.localStorage.getItem(HISTORY_ENABLED_KEY);
    return value !== 'false'; // Default to enabled
  } catch {
    return true;
  }
}

/**
 * Maximum number of count records to keep in localStorage
 * Prevents unbounded growth
 * Note: Must match backend MAX_COUNT_RECORDS (200) in input-history-service.cjs
 */
const MAX_COUNT_RECORDS = 200;

/**
 * Clean up counts to keep only the most frequently used records
 */
function cleanupCounts(counts: Record<string, number>): Record<string, number> {
  const entries = Object.entries(counts);
  if (entries.length <= MAX_COUNT_RECORDS) return counts;

  // Sort by count descending, keep top MAX_COUNT_RECORDS
  entries.sort((a, b) => b[1] - a[1]);
  const kept = entries.slice(0, MAX_COUNT_RECORDS);
  return Object.fromEntries(kept);
}

export interface UseInputHistoryOptions {
  editableRef: EditableRef;
  getTextContent: () => string;
  handleInput: (isComposingFromEvent?: boolean) => void;
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
        handleInput(false);
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

    // Batch increment usage count for all fragments (performance optimization)
    if (canUseLocalStorage()) {
      try {
        let counts = loadCounts();
        for (const fragment of fragments) {
          counts[fragment] = (counts[fragment] || 0) + 1;
        }
        counts = cleanupCounts(counts);
        window.localStorage.setItem(HISTORY_COUNTS_KEY, JSON.stringify(counts));
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

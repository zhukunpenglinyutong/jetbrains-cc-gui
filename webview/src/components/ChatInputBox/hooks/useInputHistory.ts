import { useCallback, useEffect, useRef, type RefObject } from 'react';

const STORAGE_KEY = 'chat-input-history';
/**
 * Keep the stored history bounded to avoid unbounded localStorage growth.
 * 50 is enough for quick recall while staying small even with multi-line prompts.
 */
const MAX_HISTORY_ITEMS = 50;
const INVISIBLE_CHARS_RE = /[\u200B-\u200D\uFEFF]/g;

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

function loadHistory(): string[] {
  if (!canUseLocalStorage()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

function saveHistory(items: string[]): string[] {
  if (!canUseLocalStorage()) return items;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    return items;
  } catch (err) {
    // If quota exceeded, drop older entries and retry, keeping the most recent.
    if (isQuotaExceededError(err)) {
      for (let startIndex = 1; startIndex < items.length; startIndex++) {
        try {
          const subset = items.slice(startIndex);
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(subset));
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

      handleInput(false);
    },
    [editableRef, handleInput]
  );

  const record = useCallback((text: string) => {
    const sanitized = text.replace(INVISIBLE_CHARS_RE, '');
    if (!sanitized.trim()) return;

    const currentItems = historyRef.current;
    if (currentItems.length > 0 && currentItems[currentItems.length - 1] === sanitized) {
      historyIndexRef.current = -1;
      return;
    }

    const newItems = [...currentItems, sanitized].slice(-MAX_HISTORY_ITEMS);
    const persistedItems = saveHistory(newItems);
    historyRef.current = persistedItems;
    historyIndexRef.current = -1;
    draftRef.current = '';
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

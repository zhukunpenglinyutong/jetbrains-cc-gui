import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { loadHistory, loadCounts, isHistoryCompletionEnabled, HISTORY_ENABLED_KEY } from './useInputHistory.js';

export interface UseInlineHistoryCompletionOptions {
  /** Debounce delay in milliseconds */
  debounceMs?: number;
  /** Minimum query length to trigger completion */
  minQueryLength?: number;
}

export interface UseInlineHistoryCompletionReturn {
  /** The suffix text to display as completion hint */
  suffix: string;
  /** Whether there is a suggestion available */
  hasSuggestion: boolean;
  /** Update the query text to find matching history */
  updateQuery: (text: string) => void;
  /** Clear the current suggestion */
  clear: () => void;
  /** Apply the current suggestion and return the full text */
  applySuggestion: () => string | null;
}

/**
 * Provides inline history completion for the chat input box.
 *
 * This hook shows a ghost text suffix after the user's input that
 * suggests a completion from their input history. The user can
 * press Tab to accept the suggestion.
 *
 * Features:
 * - Matches history items that start with the current input
 * - Prioritizes more frequently used items
 * - Debounces updates to avoid excessive processing
 * - Respects the enabled/disabled setting
 */
export function useInlineHistoryCompletion({
  debounceMs = 100,
  minQueryLength = 2,
}: UseInlineHistoryCompletionOptions = {}): UseInlineHistoryCompletionReturn {
  const [suffix, setSuffix] = useState('');
  const [fullSuggestion, setFullSuggestion] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(() => isHistoryCompletionEnabled());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef('');

  // Listen for storage changes to sync enabled state (cross-tab)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === HISTORY_ENABLED_KEY) {
        setEnabled(e.newValue !== 'false');
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Listen for custom event to sync enabled state (same-tab)
  useEffect(() => {
    const handleCustomEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{ enabled: boolean }>;
      setEnabled(customEvent.detail.enabled);
    };

    window.addEventListener('historyCompletionChanged', handleCustomEvent);
    return () => window.removeEventListener('historyCompletionChanged', handleCustomEvent);
  }, []);

  const findBestMatch = useCallback((query: string): string | null => {
    if (!enabled || query.length < minQueryLength) return null;

    const history = loadHistory();
    const counts = loadCounts();

    // Find all history items that start with the query (case-insensitive)
    const queryLower = query.toLowerCase();
    const matches = history.filter(item => {
      const itemLower = item.toLowerCase();
      // Must start with query and be longer than query
      return itemLower.startsWith(queryLower) && item.length > query.length;
    });

    if (matches.length === 0) return null;

    // Sort by usage count (descending), then by length (shorter first)
    matches.sort((a, b) => {
      const countA = counts[a] || 0;
      const countB = counts[b] || 0;
      if (countB !== countA) return countB - countA;
      return a.length - b.length;
    });

    return matches[0];
  }, [enabled, minQueryLength]);

  const updateQuery = useCallback((text: string) => {
    // Clear any pending debounce
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Quick check: if empty or too short, clear immediately
    const cleanText = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!cleanText || cleanText.length < minQueryLength) {
      setSuffix('');
      setFullSuggestion(null);
      lastQueryRef.current = '';
      return;
    }

    // Debounce the actual search
    debounceTimerRef.current = setTimeout(() => {
      lastQueryRef.current = cleanText;

      const match = findBestMatch(cleanText);
      if (match) {
        // Extract the suffix (part after the current input)
        const matchSuffix = match.slice(cleanText.length);
        setSuffix(matchSuffix);
        setFullSuggestion(match);
      } else {
        setSuffix('');
        setFullSuggestion(null);
      }
    }, debounceMs);
  }, [debounceMs, minQueryLength, findBestMatch]);

  const clear = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    setSuffix('');
    setFullSuggestion(null);
    lastQueryRef.current = '';
  }, []);

  const applySuggestion = useCallback((): string | null => {
    if (!fullSuggestion) return null;

    const result = fullSuggestion;

    // Clear the suggestion after applying
    setSuffix('');
    setFullSuggestion(null);
    lastQueryRef.current = '';

    return result;
  }, [fullSuggestion]);

  const hasSuggestion = useMemo(() => !!suffix && !!fullSuggestion, [suffix, fullSuggestion]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return {
    suffix,
    hasSuggestion,
    updateQuery,
    clear,
    applySuggestion,
  };
}

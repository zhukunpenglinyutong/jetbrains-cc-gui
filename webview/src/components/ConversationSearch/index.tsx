/**
 * ConversationSearch — floating in-page search panel for the chat view.
 *
 * Behavior contract (see project rule "codex-history-replay-pitfalls.md"
 * Iron Law 1: search must work the same in live and replay modes; this is
 * achieved by driving the search via `messagesSignal` instead of stream
 * lifecycle events).
 *
 * Polish features added in v0.4.4:
 *   - Case-sensitive toggle (Alt+C)
 *   - Whole-word toggle (Alt+W)
 *   - Regex toggle (Alt+R)
 *   - localStorage persistence of the three toggles
 *   - Invalid-regex visual error state
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversationSearch, DEFAULT_SEARCH_OPTIONS } from '../../hooks/useConversationSearch';
import type { SearchOptions } from '../../hooks/useConversationSearch';
import type { MessageListRevealHandle } from './types';

const STORAGE_KEY = 'cc-gui.search.options';

/** Read persisted options from localStorage. Bad data → defaults. */
function loadStoredOptions(): SearchOptions {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULT_SEARCH_OPTIONS };
    const parsed = JSON.parse(raw) as Partial<SearchOptions>;
    return {
      matchCase: !!parsed.matchCase,
      wholeWord: !!parsed.wholeWord,
      regex: !!parsed.regex,
    };
  } catch {
    return { ...DEFAULT_SEARCH_OPTIONS };
  }
}

function persistOptions(opts: SearchOptions): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(opts));
  } catch {
    // Storage quota / privacy mode — silently ignore.
  }
}

export interface ConversationSearchProps {
  /** True when the panel is visible. Controlled by the parent (UIState). */
  open: boolean;
  /** Called when the user closes the panel (Esc / × button / view change). */
  onClose: () => void;
  /** The DOM container we search inside (the messages list scroll area). */
  containerRef: React.RefObject<HTMLElement | null>;
  /**
   * Signal that changes whenever the rendered messages change. Used to
   * trigger a re-scan after streaming appends, after history loads, after
   * collapse is expanded, etc.
   */
  messagesSignal: string | number;
  /** Imperative handle for revealing collapsed earlier messages. */
  messageListRef?: React.RefObject<MessageListRevealHandle | null>;
  /** Optional ref to scroll-behavior's auto-scroll flag for cooperation. */
  isAutoScrollingRef?: React.RefObject<boolean>;
}

export const ConversationSearch = memo(function ConversationSearch({
  open,
  onClose,
  containerRef,
  messagesSignal,
  messageListRef,
  isAutoScrollingRef,
}: ConversationSearchProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [searchOptions, setSearchOptions] = useState<SearchOptions>(loadStoredOptions);

  // Persist whenever any toggle changes.
  useEffect(() => {
    persistOptions(searchOptions);
  }, [searchOptions]);

  /** Force-reveal collapsed earlier messages so we can search the whole thread. */
  const ensureRevealed = useCallback((): number => {
    const handle = messageListRef?.current;
    if (!handle) return 0;
    return handle.revealAll();
  }, [messageListRef]);

  const {
    query, setQuery,
    matches, currentIndex,
    next, previous,
    isSearching, expandedCount,
    isRegexInvalid,
    clear,
  } = useConversationSearch({
    containerRef,
    messagesSignal,
    ensureRevealed,
    enabled: open,
    searchOptions,
  });

  // Auto-focus when the panel opens.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Reveal collapsed earlier messages on panel open so the user sees the
  // full scope they are about to search BEFORE typing.
  useEffect(() => {
    if (!open) return;
    messageListRef?.current?.revealAll();
  }, [open, messageListRef]);

  // Mark autoscroll while navigating to avoid scroll-behavior pausing.
  useEffect(() => {
    if (!open || currentIndex < 0) return;
    if (isAutoScrollingRef) isAutoScrollingRef.current = true;
  }, [currentIndex, open, isAutoScrollingRef]);

  const handleClose = useCallback(() => {
    clear();
    onClose();
  }, [clear, onClose]);

  const toggleMatchCase = useCallback(() => {
    setSearchOptions((o) => ({ ...o, matchCase: !o.matchCase }));
  }, []);
  const toggleWholeWord = useCallback(() => {
    setSearchOptions((o) => ({ ...o, wholeWord: !o.wholeWord }));
  }, []);
  const toggleRegex = useCallback(() => {
    setSearchOptions((o) => ({ ...o, regex: !o.regex }));
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;

    // Alt+C / Alt+W / Alt+R — toggles. Match VS Code's find-widget shortcuts.
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') { e.preventDefault(); e.stopPropagation(); toggleMatchCase(); return; }
      if (k === 'w') { e.preventDefault(); e.stopPropagation(); toggleWholeWord(); return; }
      if (k === 'r') { e.preventDefault(); e.stopPropagation(); toggleRegex(); return; }
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) previous();
      else next();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
      return;
    }
    if (e.key === 'F3') {
      e.preventDefault();
      if (e.shiftKey) previous();
      else next();
      return;
    }
  }, [next, previous, handleClose, toggleMatchCase, toggleWholeWord, toggleRegex]);

  const counterText = useMemo(() => {
    if (!query.trim()) return '';
    if (isRegexInvalid) return t('chat.search.invalidRegex', { defaultValue: 'Invalid regex' });
    if (isSearching) return t('chat.search.searching', { defaultValue: 'Searching…' });
    if (matches.length === 0) return t('chat.search.noResults', { defaultValue: 'No results' });
    return t('chat.search.counter', {
      defaultValue: '{{current}}/{{total}}',
      current: currentIndex + 1,
      total: matches.length,
    });
  }, [query, isSearching, isRegexInvalid, matches.length, currentIndex, t]);

  if (!open) return null;

  const hasResults = matches.length > 0;
  const inputError = isRegexInvalid ||
    (query.trim().length > 0 && !isSearching && matches.length === 0);

  return (
    <div
      className="cc-search-panel"
      role="search"
      aria-label={t('chat.search.ariaLabel', { defaultValue: 'Search in conversation' })}
      onMouseDown={(e) => {
        // Prevent clicks inside the panel from blurring the input
        if (e.target !== inputRef.current) e.preventDefault();
      }}
    >
      <span className="cc-search-icon codicon codicon-search" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        className={`cc-search-input${inputError ? ' is-no-results' : ''}`}
        placeholder={t('chat.search.placeholder', { defaultValue: 'Search in conversation…' })}
        aria-label={t('chat.search.ariaLabel', { defaultValue: 'Search in conversation' })}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        autoComplete="off"
      />
      <button
        type="button"
        className={`cc-search-toggle${searchOptions.matchCase ? ' is-active' : ''}`}
        onClick={toggleMatchCase}
        title={t('chat.search.matchCase', { defaultValue: 'Match Case (Alt+C)' })}
        aria-label={t('chat.search.matchCase', { defaultValue: 'Match Case' })}
        aria-pressed={searchOptions.matchCase}
      >
        <span className="codicon codicon-case-sensitive" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`cc-search-toggle${searchOptions.wholeWord ? ' is-active' : ''}`}
        onClick={toggleWholeWord}
        title={t('chat.search.wholeWord', { defaultValue: 'Whole Word (Alt+W)' })}
        aria-label={t('chat.search.wholeWord', { defaultValue: 'Whole Word' })}
        aria-pressed={searchOptions.wholeWord}
      >
        <span className="codicon codicon-whole-word" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`cc-search-toggle${searchOptions.regex ? ' is-active' : ''}`}
        onClick={toggleRegex}
        title={t('chat.search.regex', { defaultValue: 'Regex (Alt+R)' })}
        aria-label={t('chat.search.regex', { defaultValue: 'Regex' })}
        aria-pressed={searchOptions.regex}
      >
        <span className="codicon codicon-regex" aria-hidden="true" />
      </button>
      <span className={`cc-search-counter${isRegexInvalid ? ' is-error' : ''}`} aria-live="polite">
        {counterText}
      </span>
      <button
        type="button"
        className="cc-search-btn"
        onClick={previous}
        disabled={!hasResults}
        title={t('chat.search.previous', { defaultValue: 'Previous match (Shift+Enter)' })}
        aria-label={t('chat.search.previous', { defaultValue: 'Previous match' })}
      >
        <span className="codicon codicon-arrow-up" />
      </button>
      <button
        type="button"
        className="cc-search-btn"
        onClick={next}
        disabled={!hasResults}
        title={t('chat.search.next', { defaultValue: 'Next match (Enter)' })}
        aria-label={t('chat.search.next', { defaultValue: 'Next match' })}
      >
        <span className="codicon codicon-arrow-down" />
      </button>
      <button
        type="button"
        className="cc-search-btn"
        onClick={handleClose}
        title={t('chat.search.close', { defaultValue: 'Close (Esc)' })}
        aria-label={t('chat.search.close', { defaultValue: 'Close' })}
      >
        <span className="codicon codicon-close" />
      </button>
      {expandedCount > 0 && (
        <div className="cc-search-hint" role="status">
          {t('chat.search.expandedHint', {
            defaultValue: 'Expanded {{count}} earlier messages',
            count: expandedCount,
          })}
        </div>
      )}
    </div>
  );
});

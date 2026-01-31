import { useCallback, useEffect, useRef, useState } from 'react';
import type { DropdownItemData, DropdownPosition, TriggerQuery } from '../types.js';
import { debugError, debugLog } from '../../../utils/debug.js';

interface CompletionDropdownOptions<T> {
  /** Trigger symbol */
  trigger: string;
  /** Data provider */
  provider: (query: string, signal: AbortSignal) => Promise<T[]>;
  /** Convert to dropdown item */
  toDropdownItem: (item: T) => DropdownItemData;
  /** Selection callback */
  onSelect: (item: T, query: TriggerQuery | null) => void;
  /** Debounce delay (ms) */
  debounceMs?: number;
  /** Minimum query length */
  minQueryLength?: number;
}

interface CompletionDropdownState {
  isOpen: boolean;
  items: DropdownItemData[];
  rawItems: unknown[];
  activeIndex: number;
  position: DropdownPosition | null;
  triggerQuery: TriggerQuery | null;
  loading: boolean;
  navigationMode: 'keyboard' | 'mouse';
}

/**
 * useCompletionDropdown - Unified completion dropdown hook
 * Supports debounced search, race condition protection, keyboard navigation
 */
export function useCompletionDropdown<T>({
  trigger: _trigger,
  provider,
  toDropdownItem,
  onSelect,
  debounceMs = 200,
  minQueryLength = 0,
}: CompletionDropdownOptions<T>) {
  // trigger is used to identify this hook instance, useful for debugging
  void _trigger;
  const [state, setState] = useState<CompletionDropdownState>({
    isOpen: false,
    items: [],
    rawItems: [],
    activeIndex: 0,
    position: null,
    triggerQuery: null,
    loading: false,
    navigationMode: 'keyboard',
  });

  // Debounce timer
  const debounceTimerRef = useRef<number | null>(null);
  // AbortController for canceling requests
  const abortControllerRef = useRef<AbortController | null>(null);
  // Save latest state for keyboard event handling (avoid closure issues)
  const stateRef = useRef<CompletionDropdownState>(state);

  // Sync update stateRef
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /**
   * Open dropdown
   */
  const open = useCallback((position: DropdownPosition, triggerQuery: TriggerQuery) => {
    debugLog('[useCompletionDropdown] open:', { position, triggerQuery });
    // Clear items when opening to ensure fresh data for new trigger session
    setState(prev => ({
      ...prev,
      isOpen: true,
      position,
      triggerQuery,
      activeIndex: 0,
      navigationMode: 'keyboard',
      items: [],
      rawItems: [],
      loading: true, // Set loading immediately on open
    }));
  }, []);

  /**
   * Close dropdown
   */
  const close = useCallback(() => {
    // Cancel pending requests
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      // Don't set to null here - keep the reference for proper cleanup
    }

    // Fix: Don't clear items/rawItems when closing to prevent flickering
    // when switching between different completion types (@, /, #)
    setState(prev => ({
      ...prev,
      isOpen: false,
      triggerQuery: null,
      loading: false,
    }));
  }, []);

  /**
   * Search
   */
  const search = useCallback(async (query: string) => {
    const startedAt = performance.now?.() ?? Date.now();
    debugLog('[useCompletionDropdown] search start:', { query });
    // Cancel previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Check minimum query length
    if (query.length < minQueryLength) {
      setState(prev => ({ ...prev, items: [], rawItems: [], loading: false }));
      return;
    }

    // Create new AbortController
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setState(prev => ({ ...prev, loading: true }));

    try {
      const results = await provider(query, controller.signal);

      // Check if aborted
      if (controller.signal.aborted) return;

      const items = results.map(toDropdownItem);
      const endedAt = performance.now?.() ?? Date.now();
      const durationMs = (endedAt - startedAt).toFixed(1);
      debugLog('[useCompletionDropdown] search done:', { query, resultsCount: results.length, durationMs });

      setState(prev => ({
        ...prev,
        items,
        rawItems: results as unknown[],
        loading: false,
        activeIndex: 0,
      }));
    } catch (error) {
      // Ignore abort errors
      if ((error as Error).name === 'AbortError') return;

      debugError('[useCompletionDropdown] Search error:', error);
      setState(prev => ({ ...prev, items: [], rawItems: [], loading: false }));
    }
  }, [provider, toDropdownItem, minQueryLength]);

  /**
   * Debounced search
   */
  const debouncedSearch = useCallback((query: string) => {
    // Clear previous timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Set new timer
    debounceTimerRef.current = window.setTimeout(() => {
      search(query);
    }, debounceMs);
  }, [search, debounceMs]);

  /**
   * Update query
   */
  const updateQuery = useCallback((triggerQuery: TriggerQuery) => {
    debugLog('[useCompletionDropdown] updateQuery:', triggerQuery);
    setState(prev => ({ ...prev, triggerQuery }));
    debouncedSearch(triggerQuery.query);
  }, [debouncedSearch]);

  /**
   * Select active item
   */
  const selectActive = useCallback(() => {
    const { activeIndex, rawItems, triggerQuery } = stateRef.current;
    if (activeIndex >= 0 && activeIndex < rawItems.length) {
      const item = rawItems[activeIndex] as T;
      onSelect(item, triggerQuery);
      close();
    }
  }, [onSelect, close]);

  /**
   * Select item by index
   */
  const selectIndex = useCallback((index: number) => {
    const { rawItems, triggerQuery } = stateRef.current;
    if (index >= 0 && index < rawItems.length) {
      const item = rawItems[index] as T;
      onSelect(item, triggerQuery);
      close();
    }
  }, [onSelect, close]);

  /**
   * Handle keyboard event
   * Returns true if event was handled
   */
  const handleKeyDown = useCallback((e: KeyboardEvent): boolean => {
    // Use ref to get latest state, avoid closure issues
    const currentState = stateRef.current;

    if (!currentState.isOpen) return false;

    const { items } = currentState;
    // Filter selectable items (exclude separators and headers)
    const selectableCount = items.filter(
      i => i.type !== 'separator' && i.type !== 'section-header'
    ).length;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        // Prevent division by zero: when no selectable items, keep activeIndex at 0
        if (selectableCount === 0) return true;
        setState(prev => ({
          ...prev,
          activeIndex: (prev.activeIndex + 1) % selectableCount,
          navigationMode: 'keyboard',
        }));
        return true;

      case 'ArrowUp':
        e.preventDefault();
        // Prevent division by zero: when no selectable items, keep activeIndex at 0
        if (selectableCount === 0) return true;
        setState(prev => ({
          ...prev,
          activeIndex: (prev.activeIndex - 1 + selectableCount) % selectableCount,
          navigationMode: 'keyboard',
        }));
        return true;

      case 'Enter':
      case 'Tab':
        e.preventDefault();
        selectActive();
        return true;

      case 'Escape':
        e.preventDefault();
        close();
        return true;

      default:
        return false;
    }
  }, [selectActive, close]); // Only depend on functions that don't change frequently

  /**
   * Handle mouse enter
   */
  const handleMouseEnter = useCallback((index: number) => {
    setState(prev => ({
      ...prev,
      activeIndex: index,
      navigationMode: 'mouse',
    }));
  }, []);

  /**
   * Replace text
   */
  const replaceText = useCallback((
    fullText: string,
    replacement: string,
    triggerQuery: TriggerQuery | null
  ): string => {
    if (!triggerQuery) return fullText;

    const before = fullText.slice(0, triggerQuery.start);
    const after = fullText.slice(triggerQuery.end);

    return before + replacement + after;
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    // State
    isOpen: state.isOpen,
    items: state.items,
    activeIndex: state.activeIndex,
    position: state.position,
    triggerQuery: state.triggerQuery,
    loading: state.loading,
    navigationMode: state.navigationMode,

    // Methods
    open,
    close,
    updateQuery,
    handleKeyDown,
    handleMouseEnter,
    selectActive,
    selectIndex,
    replaceText,
  };
}

export default useCompletionDropdown;

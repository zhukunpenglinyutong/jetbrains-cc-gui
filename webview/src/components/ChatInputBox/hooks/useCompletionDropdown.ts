import { useCallback, useEffect, useRef, useState } from 'react';
import type { DropdownItemData, DropdownPosition, TriggerQuery } from '../types';

interface CompletionDropdownOptions<T> {
  /** 触发符号 */
  trigger: string;
  /** 数据提供者 */
  provider: (query: string, signal: AbortSignal) => Promise<T[]>;
  /** 转换为下拉项 */
  toDropdownItem: (item: T) => DropdownItemData;
  /** 选择回调 */
  onSelect: (item: T, query: TriggerQuery | null) => void;
  /** 防抖延迟 (ms) */
  debounceMs?: number;
  /** 最小查询长度 */
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
 * useCompletionDropdown - 统一补全下拉 Hook
 * 支持防抖搜索、竞态保护、键盘导航
 */
export function useCompletionDropdown<T>({
  trigger: _trigger,
  provider,
  toDropdownItem,
  onSelect,
  debounceMs = 200,
  minQueryLength = 0,
}: CompletionDropdownOptions<T>) {
  // trigger 用于标识当前 hook 实例，在调试时有用
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

  // 防抖计时器
  const debounceTimerRef = useRef<number | null>(null);
  // AbortController 用于取消请求
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * 打开下拉
   */
  const open = useCallback((position: DropdownPosition, triggerQuery: TriggerQuery) => {
    setState(prev => ({
      ...prev,
      isOpen: true,
      position,
      triggerQuery,
      activeIndex: 0,
      navigationMode: 'keyboard',
    }));
  }, []);

  /**
   * 关闭下拉
   */
  const close = useCallback(() => {
    // 取消待处理的请求
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    setState(prev => ({
      ...prev,
      isOpen: false,
      items: [],
      rawItems: [],
      triggerQuery: null,
      loading: false,
    }));
  }, []);

  /**
   * 搜索
   */
  const search = useCallback(async (query: string) => {
    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // 检查最小查询长度
    if (query.length < minQueryLength) {
      setState(prev => ({ ...prev, items: [], rawItems: [], loading: false }));
      return;
    }

    // 创建新的 AbortController
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setState(prev => ({ ...prev, loading: true }));

    try {
      const results = await provider(query, controller.signal);

      // 检查是否被取消
      if (controller.signal.aborted) return;

      const items = results.map(toDropdownItem);

      setState(prev => ({
        ...prev,
        items,
        rawItems: results as unknown[],
        loading: false,
        activeIndex: 0,
      }));
    } catch (error) {
      // 忽略取消错误
      if ((error as Error).name === 'AbortError') return;

      console.error('[useCompletionDropdown] Search error:', error);
      setState(prev => ({ ...prev, items: [], rawItems: [], loading: false }));
    }
  }, [provider, toDropdownItem, minQueryLength]);

  /**
   * 防抖搜索
   */
  const debouncedSearch = useCallback((query: string) => {
    // 清除之前的计时器
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // 设置新的计时器
    debounceTimerRef.current = window.setTimeout(() => {
      search(query);
    }, debounceMs);
  }, [search, debounceMs]);

  /**
   * 更新查询
   */
  const updateQuery = useCallback((triggerQuery: TriggerQuery) => {
    setState(prev => ({ ...prev, triggerQuery }));
    debouncedSearch(triggerQuery.query);
  }, [debouncedSearch]);

  /**
   * 选择当前项
   */
  const selectActive = useCallback(() => {
    const { activeIndex, rawItems, triggerQuery } = state;
    if (activeIndex >= 0 && activeIndex < rawItems.length) {
      const item = rawItems[activeIndex] as T;
      onSelect(item, triggerQuery);
      close();
    }
  }, [state, onSelect, close]);

  /**
   * 选择指定索引
   */
  const selectIndex = useCallback((index: number) => {
    const { rawItems, triggerQuery } = state;
    if (index >= 0 && index < rawItems.length) {
      const item = rawItems[index] as T;
      onSelect(item, triggerQuery);
      close();
    }
  }, [state, onSelect, close]);

  /**
   * 处理键盘事件
   * 返回 true 表示事件已处理
   */
  const handleKeyDown = useCallback((e: KeyboardEvent): boolean => {
    if (!state.isOpen) return false;

    const { items } = state;
    const selectableCount = items.filter(
      i => i.type !== 'separator' && i.type !== 'section-header'
    ).length;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setState(prev => ({
          ...prev,
          activeIndex: (prev.activeIndex + 1) % selectableCount,
          navigationMode: 'keyboard',
        }));
        return true;

      case 'ArrowUp':
        e.preventDefault();
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
  }, [state, selectActive, close]);

  /**
   * 处理鼠标进入
   */
  const handleMouseEnter = useCallback((index: number) => {
    setState(prev => ({
      ...prev,
      activeIndex: index,
      navigationMode: 'mouse',
    }));
  }, []);

  /**
   * 替换文本
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

  // 清理
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
    // 状态
    isOpen: state.isOpen,
    items: state.items,
    activeIndex: state.activeIndex,
    position: state.position,
    triggerQuery: state.triggerQuery,
    loading: state.loading,
    navigationMode: state.navigationMode,

    // 方法
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

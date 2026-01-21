import { useRef } from 'react';

type ViewMode = 'chat' | 'history' | 'settings';

export interface UseScrollBehaviorOptions {
  currentView: ViewMode;
  messages: unknown[];
  expandedThinking?: Record<string, boolean>;
  loading: boolean;
  streamingActive: boolean;
}

interface UseScrollBehaviorReturn {
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  inputAreaRef: React.RefObject<HTMLDivElement | null>;
  isUserAtBottomRef: React.MutableRefObject<boolean>;
  isAutoScrollingRef: React.MutableRefObject<boolean>;
}

/**
 * Hook for managing scroll behavior references in the chat view
 *
 * 注意：自从使用 react-virtuoso 后，大部分滚动逻辑已由 Virtuoso 处理：
 * - 自动滚动到底部：Virtuoso 的 followOutput prop
 * - 跟踪用户是否在底部：Virtuoso 的 atBottomStateChange 回调
 * - 滚动到指定位置：通过 MessageList 的 ref 暴露的方法
 *
 * 这个 hook 现在主要提供 refs：
 * - messagesContainerRef: 作为 Virtuoso 的 customScrollParent，让 ScrollControl 继续工作
 * - messagesEndRef: 保留向后兼容
 * - inputAreaRef: 用于 ScrollControl 计算位置
 * - isUserAtBottomRef: 由 MessageList 的 onAtBottomStateChange 更新
 *
 * @deprecated options 参数已不再使用，保留仅为 API 兼容性。
 * 未来版本可能会移除此参数，请勿依赖 options 中的任何字段。
 */
export function useScrollBehavior(
  // @deprecated - 保留参数以保持 API 兼容性，但现在由 Virtuoso 处理
  _options?: UseScrollBehaviorOptions
): UseScrollBehaviorReturn {
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputAreaRef = useRef<HTMLDivElement | null>(null);
  const isUserAtBottomRef = useRef(true);
  const isAutoScrollingRef = useRef(false);

  // 注意：scrollToBottom 功能现在由 MessageList ref 提供
  // 如需滚动到底部，使用 messageListRef.current?.scrollToBottom()

  return {
    messagesContainerRef,
    messagesEndRef,
    inputAreaRef,
    isUserAtBottomRef,
    isAutoScrollingRef,
  };
}

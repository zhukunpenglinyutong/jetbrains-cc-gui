import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ClaudeMessage } from '../types';

type ViewMode = 'chat' | 'history' | 'settings';

export interface UseScrollBehaviorOptions {
  currentView: ViewMode;
  messages: ClaudeMessage[];
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
  scrollToBottom: () => void;
}

/**
 * Hook for managing scroll behavior in the chat view
 * - Tracks if user is at bottom
 * - Auto-scrolls to bottom when user is at bottom and new content arrives
 * - Handles view switching scroll behavior
 */
export function useScrollBehavior({
  currentView,
  messages,
  expandedThinking,
  loading,
  streamingActive,
}: UseScrollBehaviorOptions): UseScrollBehaviorReturn {
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputAreaRef = useRef<HTMLDivElement | null>(null);
  const isUserAtBottomRef = useRef(true);
  const isAutoScrollingRef = useRef(false);

  // Scroll to bottom function
  const scrollToBottom = useCallback(() => {
    const endElement = messagesEndRef.current;
    if (endElement) {
      isAutoScrollingRef.current = true;
      try {
        endElement.scrollIntoView({ block: 'end', behavior: 'auto' });
      } catch {
        endElement.scrollIntoView(false);
      }
      requestAnimationFrame(() => {
        isAutoScrollingRef.current = false;
      });
      return;
    }

    const container = messagesContainerRef.current;
    if (!container) return;

    isAutoScrollingRef.current = true;
    container.scrollTop = container.scrollHeight;
    requestAnimationFrame(() => {
      isAutoScrollingRef.current = false;
    });
  }, []);

  // Listen to scroll events to detect if user is at bottom
  // If user scrolls up to view history, mark as "not at bottom" and stop auto-scrolling
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Skip check during auto-scrolling to prevent false detection during fast streaming
      if (isAutoScrollingRef.current) return;
      // Calculate distance from bottom
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      // Consider user at bottom if within 100 pixels
      isUserAtBottomRef.current = distanceFromBottom < 100;
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [currentView]);

  // Auto-scroll: follow latest content when user is at bottom
  // Includes streaming, expanded thinking blocks, loading indicator, etc.
  useLayoutEffect(() => {
    if (currentView !== 'chat') return;
    if (!isUserAtBottomRef.current) return;
    scrollToBottom();
  }, [currentView, messages, expandedThinking, loading, streamingActive, scrollToBottom]);

  // Scroll to bottom when switching back to chat view
  useEffect(() => {
    if (currentView === 'chat') {
      // Use setTimeout to ensure view is fully rendered before scrolling
      const timer = setTimeout(() => {
        scrollToBottom();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [currentView, scrollToBottom]);

  return {
    messagesContainerRef,
    messagesEndRef,
    inputAreaRef,
    isUserAtBottomRef,
    isAutoScrollingRef,
    scrollToBottom,
  };
}

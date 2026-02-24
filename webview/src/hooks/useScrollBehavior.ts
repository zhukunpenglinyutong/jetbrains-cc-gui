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
  userPausedRef: React.MutableRefObject<boolean>;
  scrollToBottom: () => void;
}

/**
 * Hook for managing scroll behavior in the chat view
 * - Tracks if user is at bottom
 * - Auto-scrolls to bottom when user is at bottom and new content arrives
 * - User can scroll up to pause auto-scroll (wheel event detection)
 * - Auto-scroll resumes only when user scrolls back to bottom
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

  // Explicit scroll-pause flag. Set by wheel-up, cleared only when user
  // manually scrolls back to the very bottom. The scroll event handler
  // cannot override this — it prevents the race condition where handleScroll
  // fires right after handleWheel and resets isUserAtBottomRef to true
  // because the viewport is still within the 100px threshold.
  const userPausedRef = useRef(false);

  // Scroll to bottom function
  const scrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (container) {
      isAutoScrollingRef.current = true;
      container.scrollTop = container.scrollHeight;
      requestAnimationFrame(() => {
        isAutoScrollingRef.current = false;
      });
      return;
    }

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
  }, []);

  // Warm up layout after window regains focus (macOS JCEF drops GPU layers
  // when the window is in the background, causing a scroll stutter on return)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) return;
      const container = messagesContainerRef.current;
      if (!container) return;
      // Force layout recalculation before user's first scroll frame
      requestAnimationFrame(() => {
        void container.scrollHeight;
        void container.offsetHeight;
      });
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Listen to scroll and wheel events to detect user scroll intent
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    // Throttle scroll handler via rAF — fires at most once per frame
    let scrollRafId: number | null = null;
    const handleScroll = () => {
      if (scrollRafId !== null) return; // already scheduled
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = null;
        // Skip check during auto-scrolling to prevent false detection during fast streaming
        if (isAutoScrollingRef.current) return;
        // If user explicitly paused via wheel-up, don't let scroll handler override
        if (userPausedRef.current) return;
        // Calculate distance from bottom
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        // Consider user at bottom if within 100 pixels
        isUserAtBottomRef.current = distanceFromBottom < 100;
      });
    };

    // Wheel events are ALWAYS user-initiated and cannot be confused with
    // programmatic scrolls. This is the primary mechanism for detecting
    // user intent to pause or resume auto-scroll.
    let wheelRafId: number | null = null;
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User is scrolling UP → pause auto-scroll immediately
        userPausedRef.current = true;
        isUserAtBottomRef.current = false;
      } else if (e.deltaY > 0) {
        // User is scrolling DOWN → check if they reached the bottom to unpause
        if (wheelRafId !== null) cancelAnimationFrame(wheelRafId);
        wheelRafId = requestAnimationFrame(() => {
          wheelRafId = null;
          const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
          if (distanceFromBottom < 100) {
            userPausedRef.current = false;
            isUserAtBottomRef.current = true;
          }
        });
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleWheel);
      if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
      if (wheelRafId !== null) cancelAnimationFrame(wheelRafId);
    };
  }, [currentView]);

  // Auto-scroll: follow latest content when user is at bottom
  // Includes streaming, expanded thinking blocks, loading indicator, etc.
  useLayoutEffect(() => {
    if (currentView !== 'chat') return;
    if (userPausedRef.current) return;
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
    userPausedRef,
    scrollToBottom,
  };
}

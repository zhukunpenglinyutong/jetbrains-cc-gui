import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ClaudeMessage } from '../types';

const SCROLL_ANCHOR_ENABLED_CLASS = 'scroll-anchor-enabled';
const BOTTOM_THRESHOLD_PX = 100;

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

  const syncScrollAnchoring = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const shouldEnableScrollAnchoring = userPausedRef.current || !isUserAtBottomRef.current;
    container.classList.toggle(SCROLL_ANCHOR_ENABLED_CLASS, shouldEnableScrollAnchoring);
  }, []);

  const syncUserAtBottomState = useCallback((container: HTMLDivElement) => {
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    isUserAtBottomRef.current = distanceFromBottom < BOTTOM_THRESHOLD_PX;
    syncScrollAnchoring();
  }, [syncScrollAnchoring]);

  // Scroll to bottom function
  const scrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    const endElement = messagesEndRef.current;

    if (endElement) {
      // Force the browser to resolve layout all the way to the end marker
      // before we read scrollHeight. This avoids intermediate scroll targets
      // when the last message uses deferred layout/content-visibility and
      // grows in multiple phases (common for Agent tool blocks).
      void endElement.getBoundingClientRect();
      void endElement.offsetTop;
    }

    if (container) {
      isAutoScrollingRef.current = true;
      isUserAtBottomRef.current = true;
      container.classList.remove(SCROLL_ANCHOR_ENABLED_CLASS);
      container.scrollTop = container.scrollHeight;
      requestAnimationFrame(() => {
        isAutoScrollingRef.current = false;
      });
      return;
    }

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

    syncScrollAnchoring();

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
        syncUserAtBottomState(container);
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
        syncScrollAnchoring();
      } else if (e.deltaY > 0) {
        // User is scrolling DOWN → check if they reached the bottom to unpause
        if (wheelRafId !== null) cancelAnimationFrame(wheelRafId);
        wheelRafId = requestAnimationFrame(() => {
          wheelRafId = null;
          const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
          if (distanceFromBottom < BOTTOM_THRESHOLD_PX) {
            userPausedRef.current = false;
            isUserAtBottomRef.current = true;
          }
          syncScrollAnchoring();
        });
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleWheel);
      container.classList.remove(SCROLL_ANCHOR_ENABLED_CLASS);
      if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
      if (wheelRafId !== null) cancelAnimationFrame(wheelRafId);
    };
  }, [currentView, syncScrollAnchoring, syncUserAtBottomState]);

  // Follow content height changes that don't replace the message array, such as
  // subagent/task detail updates inside the currently streaming assistant block.
  // The observer should be stable across streaming ticks; only recreate on view change.
  useEffect(() => {
    if (currentView !== 'chat') return;
    const container = messagesContainerRef.current;
    if (!container) return;
    if (typeof ResizeObserver === 'undefined') return;

    const observedElement = messagesEndRef.current?.parentElement ?? container.firstElementChild;
    if (!(observedElement instanceof HTMLElement)) return;

    let resizeRafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeRafId !== null) {
        cancelAnimationFrame(resizeRafId);
      }
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        // Read current state from refs — these are updated by other effects/handlers
        const shouldStickToBottom = !userPausedRef.current && isUserAtBottomRef.current;
        if (userPausedRef.current) {
          syncScrollAnchoring();
          return;
        }
        if (shouldStickToBottom) {
          scrollToBottom();
          return;
        }
        syncUserAtBottomState(container);
      });
    });

    observer.observe(observedElement);
    return () => {
      observer.disconnect();
      if (resizeRafId !== null) {
        cancelAnimationFrame(resizeRafId);
      }
    };
  }, [currentView, scrollToBottom, syncScrollAnchoring, syncUserAtBottomState]);

  // Auto-scroll: follow latest content when user is at bottom
  // Includes streaming, expanded thinking blocks, loading indicator, etc.
  // During streaming, debounce with rAF to coalesce rapid state changes
  // from multiple update channels (onContentDelta + updateMessages) into
  // a single scroll-to-bottom per frame, preventing visual jitter.
  const scrollDebounceRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (currentView !== 'chat') return;
    syncScrollAnchoring();
    if (userPausedRef.current) return;
    if (!isUserAtBottomRef.current) return;

    if (streamingActive) {
      if (scrollDebounceRef.current !== null) {
        cancelAnimationFrame(scrollDebounceRef.current);
      }
      scrollDebounceRef.current = requestAnimationFrame(() => {
        scrollDebounceRef.current = null;
        if (!userPausedRef.current && isUserAtBottomRef.current) {
          scrollToBottom();
        }
      });
    } else {
      scrollToBottom();
    }
  }, [currentView, messages, expandedThinking, loading, streamingActive, scrollToBottom, syncScrollAnchoring]);

  // Cleanup scroll debounce on unmount
  useEffect(() => {
    return () => {
      if (scrollDebounceRef.current !== null) {
        cancelAnimationFrame(scrollDebounceRef.current);
      }
    };
  }, []);

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

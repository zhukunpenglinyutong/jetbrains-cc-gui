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
 * Keeps chat following new content and viewport resizing until the user scrolls away.
 * Wheel-up pauses following until the user wheels back to the bottom.
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
  const scrollRafRef = useRef<number | null>(null);
  const layoutRafRef = useRef<number | null>(null);

  // Keep wheel-up intent until a downward wheel reaches the bottom threshold.
  // Scroll callbacks must not undo a pause while the viewport is still nearby.
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
  //
  // Two-step strategy for reliability across browsers and mid-streaming
  // layout phases (Agent tool blocks expand in multiple ticks):
  //
  //   Step 1 — `scrollTop = scrollHeight`: deterministic landing path that
  //     also exercises the test environment (jsdom does not implement
  //     `scrollIntoView` faithfully).
  //
  //   Step 2 — `scrollIntoView({block: 'end'})`: provides browser-native
  //     end-positioning. Even though step 1 alone is usually sufficient, this
  //     extra call hardens against intermediate scroll targets when the last
  //     message grows in multiple paint phases (e.g. tool blocks streaming
  //     in one-by-one). Force-reading `getBoundingClientRect`/`offsetTop`
  //     beforehand ensures layout is up-to-date before the scroll command.
  const scrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    const endElement = messagesEndRef.current;

    if (!container && !endElement) return;

    isAutoScrollingRef.current = true;
    isUserAtBottomRef.current = true;
    container?.classList.remove(SCROLL_ANCHOR_ENABLED_CLASS);

    if (endElement) {
      void endElement.getBoundingClientRect();
      void endElement.offsetTop;
    }

    // Step 1: deterministic scrollTop adjustment.
    if (container) {
      container.scrollTop = container.scrollHeight;
    }

    // Step 2: native end-positioning (handles late-arriving layout).
    if (endElement) {
      try {
        endElement.scrollIntoView({ block: 'end', behavior: 'auto' });
      } catch {
        try {
          endElement.scrollIntoView(false);
        } catch {
          // No-op: scrollTop fallback already executed in Step 1.
        }
      }
    }

    requestAnimationFrame(() => {
      isAutoScrollingRef.current = false;
    });
  }, []);

  // Streaming updates and resize notifications share one layout pass per frame.
  const followLayoutChanges = useCallback(() => {
    if (layoutRafRef.current !== null) return;
    layoutRafRef.current = requestAnimationFrame(() => {
      layoutRafRef.current = null;
      const container = messagesContainerRef.current;
      // Let a pending user scroll establish intent before following layout changes.
      if (!container || scrollRafRef.current !== null) return;
      if (userPausedRef.current) {
        syncScrollAnchoring();
        return;
      }
      // Preserve follow intent before a large resize can change the bottom distance.
      if (isUserAtBottomRef.current) {
        scrollToBottom();
        return;
      }
      syncUserAtBottomState(container);
    });
  }, [scrollToBottom, syncScrollAnchoring, syncUserAtBottomState]);

  // Cancel old-view work before layout effects can schedule work for the new view.
  useLayoutEffect(() => {
    return () => {
      if (layoutRafRef.current !== null) {
        cancelAnimationFrame(layoutRafRef.current);
        layoutRafRef.current = null;
      }
    };
  }, [currentView]);

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
    if (currentView !== 'chat') return;
    const container = messagesContainerRef.current;
    if (!container) return;

    syncScrollAnchoring();

    // Throttle scroll handler via rAF — fires at most once per frame
    const handleScroll = () => {
      // Capture automatic scrolling now; its flag may clear before the next frame.
      if (isAutoScrollingRef.current) return;
      if (scrollRafRef.current !== null) return; // already scheduled
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
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
      if (e.deltaY === 0) return;
      // A newer wheel direction must supersede a queued resume check.
      if (wheelRafId !== null) {
        cancelAnimationFrame(wheelRafId);
        wheelRafId = null;
      }
      if (e.deltaY < 0) {
        // User is scrolling UP → pause auto-scroll immediately
        userPausedRef.current = true;
        isUserAtBottomRef.current = false;
        syncScrollAnchoring();
      } else if (e.deltaY > 0) {
        // User is scrolling DOWN → check if they reached the bottom to unpause
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
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (wheelRafId !== null) cancelAnimationFrame(wheelRafId);
    };
  }, [currentView, syncScrollAnchoring, syncUserAtBottomState]);

  // Content growth and input/panel resizing can move the bottom without scroll
  // events or message updates. Observe both boxes without resubscribing per tick.
  useEffect(() => {
    if (currentView !== 'chat') return;
    const container = messagesContainerRef.current;
    if (!container) return;
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(followLayoutChanges);

    observer.observe(container);
    const observedElement = messagesEndRef.current?.parentElement ?? container.firstElementChild;
    if (observedElement instanceof HTMLElement) {
      observer.observe(observedElement);
    }
    return () => observer.disconnect();
  }, [currentView, followLayoutChanges]);

  // Auto-scroll: follow latest content when user is at bottom
  // Includes streaming, expanded thinking blocks, loading indicator, etc.
  // Streaming shares the resize frame so overlapping updates cannot scroll twice.
  useLayoutEffect(() => {
    if (currentView !== 'chat') return;
    syncScrollAnchoring();
    if (userPausedRef.current) return;
    if (!isUserAtBottomRef.current) return;
    if (scrollRafRef.current !== null) return;

    if (streamingActive) {
      followLayoutChanges();
    } else {
      scrollToBottom();
    }
  }, [currentView, messages, expandedThinking, loading, streamingActive, scrollToBottom, syncScrollAnchoring, followLayoutChanges]);

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

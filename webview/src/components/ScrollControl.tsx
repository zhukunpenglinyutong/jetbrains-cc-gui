import { memo, useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getAppViewport } from '../utils/viewport';

interface ScrollControlProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  inputAreaRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * ScrollControl - Scroll control button component
 * Features:
 * - Shows up arrow when scrolling up; click to go to top
 * - Shows down arrow when scrolling down; click to go to bottom
 * - Hidden when already at the bottom
 * - Hidden when content fits within one screen
 * - Always positioned 20px above the input area
 */
export const ScrollControl = memo(({ containerRef, inputAreaRef }: ScrollControlProps) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [direction, setDirection] = useState<'up' | 'down'>('down');
  const [bottomOffset, setBottomOffset] = useState(120);
  const hideTimerRef = useRef<number | null>(null);

  const THRESHOLD = 100; // Distance from bottom threshold (pixels)
  const HIDE_DELAY = 1500; // Delay before hiding after scrolling stops (milliseconds)

  /**
   * Update button position to always stay 20px above the input area
   */
  const updatePosition = useCallback(() => {
    if (inputAreaRef?.current) {
      const inputRect = inputAreaRef.current.getBoundingClientRect();
      // Use #app's rect as reference - both rects are in the same coordinate space
      const { height: viewportHeight, top: viewportTop, fixedPosDivisor } = getAppViewport();
      const newBottom = (viewportHeight - (inputRect.top - viewportTop) + 20) / fixedPosDivisor;
      setBottomOffset(newBottom);
    }
  }, [inputAreaRef]);

  /**
   * Check scroll position and update button state
   */
  const checkScrollPosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;

    // Content fits within one screen, hide button
    if (scrollHeight <= clientHeight) {
      setVisible(false);
      return;
    }

    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // At the bottom (distance < THRESHOLD), hide button
    if (distanceFromBottom < THRESHOLD) {
      setVisible(false);
    }
  }, [containerRef]);

  /**
   * Handle mouse wheel events
   */
  const handleWheel = useCallback((e: WheelEvent) => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;

    // Content fits within one screen, don't show
    if (scrollHeight <= clientHeight) {
      return;
    }

    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // At the bottom, don't show
    if (distanceFromBottom < THRESHOLD) {
      setVisible(false);
      return;
    }

    // Clear previous hide timer
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }

    // Set arrow direction based on wheel direction
    // deltaY > 0 means scrolling down (content moves up), show down arrow
    // deltaY < 0 means scrolling up (content moves down), show up arrow
    if (e.deltaY > 0) {
      setDirection('down');
    } else if (e.deltaY < 0) {
      setDirection('up');
    }

    setVisible(true);

    // Set hide timer
    hideTimerRef.current = setTimeout(() => {
      setVisible(false);
    }, HIDE_DELAY);
  }, [containerRef]);

  /**
   * Scroll to top
   */
  const scrollToTop = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }, [containerRef]);

  /**
   * Scroll to bottom
   */
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior: 'smooth',
    });
  }, [containerRef]);

  /**
   * Handle click event
   */
  const handleClick = useCallback(() => {
    if (direction === 'up') {
      scrollToTop();
    } else {
      scrollToBottom();
    }
    // Hide button after click
    setVisible(false);
  }, [direction, scrollToTop, scrollToBottom]);

  /**
   * Listen for scroll and wheel events
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Initial check
    checkScrollPosition();
    updatePosition();

    // Add scroll listener (to detect if bottom is reached)
    container.addEventListener('scroll', checkScrollPosition);

    // Add wheel listener (to detect scroll direction)
    container.addEventListener('wheel', handleWheel, { passive: true });

    // Listen for window resize
    const handleResize = () => {
      checkScrollPosition();
      updatePosition();
    };
    window.addEventListener('resize', handleResize);

    // Use ResizeObserver to watch for input area size changes
    let resizeObserver: ResizeObserver | null = null;
    if (inputAreaRef?.current) {
      resizeObserver = new ResizeObserver(updatePosition);
      resizeObserver.observe(inputAreaRef.current);
    }

    return () => {
      container.removeEventListener('scroll', checkScrollPosition);
      container.removeEventListener('wheel', handleWheel);
      window.removeEventListener('resize', handleResize);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, [containerRef, inputAreaRef, checkScrollPosition, handleWheel, updatePosition]);

  if (!visible) return null;

  return (
    <button
      className="scroll-control-button"
      style={{ bottom: `${bottomOffset}px` }}
      onClick={handleClick}
      aria-label={direction === 'up' ? t('chat.backToTop') : t('chat.backToBottom')}
      title={direction === 'up' ? t('chat.backToTop') : t('chat.backToBottom')}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transform: direction === 'up' ? 'rotate(180deg)' : 'none' }}
      >
        <path d="M12 5v14M19 12l-7 7-7-7" />
      </svg>
    </button>
  );
});

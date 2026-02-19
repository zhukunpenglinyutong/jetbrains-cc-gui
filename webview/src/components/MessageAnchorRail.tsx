import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClaudeMessage } from '../types';
import { getMessageKey } from '../utils/messageUtils';

interface AnchorItem {
  id: string;
  position: number;
  preview: string;
}

interface MessageAnchorRailProps {
  messages: ClaudeMessage[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  messageNodeMap: React.RefObject<Map<string, HTMLDivElement>>;
}

const MAX_PREVIEW_LENGTH = 300;
const TOOLTIP_DELAY_MS = 500;

/**
 * Extracts a short preview text from a user message for the tooltip.
 * Strips control characters and collapses excessive whitespace for clean display.
 */
function getMessagePreview(message: ClaudeMessage): string {
  const raw = message.content?.trim() ?? '';
  if (!raw) return '';
  // Strip control characters (except common whitespace) and collapse runs of whitespace
  const text = raw
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= MAX_PREVIEW_LENGTH) return text;
  return text.slice(0, MAX_PREVIEW_LENGTH) + '...';
}

export const MessageAnchorRail = memo(function MessageAnchorRail({
  messages,
  containerRef,
  messageNodeMap,
}: MessageAnchorRailProps) {
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  const [tooltipAnchorId, setTooltipAnchorId] = useState<string | null>(null);
  const rafRef = useRef<number>(0);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTooltipTimer = useCallback(() => {
    if (tooltipTimerRef.current !== null) {
      clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
  }, []);

  const handleDotMouseEnter = useCallback((anchorId: string) => {
    clearTooltipTimer();
    tooltipTimerRef.current = setTimeout(() => {
      setTooltipAnchorId(anchorId);
    }, TOOLTIP_DELAY_MS);
  }, [clearTooltipTimer]);

  const handleDotMouseLeave = useCallback(() => {
    clearTooltipTimer();
    setTooltipAnchorId(null);
  }, [clearTooltipTimer]);

  // Cleanup timer on unmount
  useEffect(() => clearTooltipTimer, [clearTooltipTimer]);

  // Compute anchor items from user messages only
  const anchors = useMemo<AnchorItem[]>(() => {
    const userMessages: AnchorItem[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].type === 'user') {
        userMessages.push({
          id: getMessageKey(messages[i], i),
          position: 0,
          preview: getMessagePreview(messages[i]),
        });
      }
    }
    // Guard: also prevents division by zero in the position calculation below
    if (userMessages.length <= 1) return [];
    // Distribute positions evenly between 4% and 96%
    return userMessages.map((item, idx) => ({
      ...item,
      position: 0.04 + (idx / (userMessages.length - 1)) * 0.92,
    }));
  }, [messages]);

  // Scroll to a specific anchor message
  const scrollToAnchor = useCallback((messageId: string) => {
    const node = messageNodeMap.current?.get(messageId);
    const container = containerRef.current;
    if (!node || !container) return;

    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const targetTop =
      container.scrollTop + (nodeRect.top - containerRect.top) - container.clientHeight * 0.28;

    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: 'smooth',
    });
    setActiveAnchorId(messageId);
  }, [containerRef, messageNodeMap]);

  // Compute which anchor is closest to the viewport reference point
  const computeActiveAnchor = useCallback((): string | null => {
    const container = containerRef.current;
    const nodeMap = messageNodeMap.current;
    if (!container || !nodeMap) return null;

    const viewportAnchorY =
      container.getBoundingClientRect().top + Math.min(96, container.clientHeight * 0.32);

    let bestId: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [messageId, node] of nodeMap) {
      const distance = Math.abs(node.getBoundingClientRect().top - viewportAnchorY);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = messageId;
      }
    }
    return bestId;
  }, [containerRef, messageNodeMap]);

  // Track scroll to update active anchor
  useEffect(() => {
    const container = containerRef.current;
    if (!container || anchors.length === 0) return;

    const handleScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const activeId = computeActiveAnchor();
        if (activeId) {
          setActiveAnchorId((prev) => (prev === activeId ? prev : activeId));
        }
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    // Compute initial active anchor
    handleScroll();

    return () => {
      container.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [containerRef, anchors, computeActiveAnchor]);

  if (anchors.length === 0) return null;

  return (
    <div className="messages-anchor-rail" role="navigation" aria-label="Message anchors">
      <div className="messages-anchor-track" aria-hidden="true" />
      {anchors.map((anchor, index) => {
        const isActive = activeAnchorId === anchor.id;
        const showTooltip = tooltipAnchorId === anchor.id && anchor.preview;
        return (
          <div
            key={anchor.id}
            role="button"
            tabIndex={0}
            className={`messages-anchor-dot${isActive ? ' is-active' : ''}`}
            style={{ top: `${anchor.position * 100}%` }}
            onClick={() => scrollToAnchor(anchor.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                scrollToAnchor(anchor.id);
              }
            }}
            onMouseEnter={() => handleDotMouseEnter(anchor.id)}
            onMouseLeave={handleDotMouseLeave}
            aria-label={`Go to user message ${index + 1}`}
          >
            {showTooltip && (
              <div className="anchor-tooltip">{anchor.preview}</div>
            )}
          </div>
        );
      })}
    </div>
  );
});

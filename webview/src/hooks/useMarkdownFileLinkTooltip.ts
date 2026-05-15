import { useCallback, useEffect, useRef } from 'react';
import { resolveFilePathWithCallback } from '../utils/bridge';
import { useFloatingTextTooltip } from './useFloatingTextTooltip';
import { LRUCache } from '../utils/lruCache';

/**
 * Hook for managing file link tooltips in Markdown content.
 * Handles mouseover/mousemove/mouseout events on file links and displays
 * resolved project-relative paths in a floating tooltip.
 */
export function useMarkdownFileLinkTooltip() {
  const currentHoverHrefRef = useRef<string | null>(null);
  const currentHoverAnchorRef = useRef<HTMLAnchorElement | null>(null);
  const lastTooltipHrefRef = useRef<string | null>(null);
  // Cache resolved tooltip texts per href to prevent flicker during streaming
  // when DOM replacement causes repeated mouseover/mouseout cycles.
  // Use LRU cache to prevent unbounded memory growth in long sessions.
  const resolvedTooltipTextRef = useRef<LRUCache<string, string>>(new LRUCache(200));
  const currentTooltipTextRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const latestMousePositionRef = useRef({ clientX: 0, clientY: 0 });
  const floatingTooltip = useFloatingTextTooltip();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleMouseOver = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // Text nodes don't have closest() — walk up to the nearest element.
    // Cast target to Node first so nodeType is readable on Text nodes.
    const targetNode = target as unknown as Node;
    const element = targetNode.nodeType === Node.TEXT_NODE
      ? (targetNode as Text).parentElement
      : target;
    const anchor = element?.closest('a') as HTMLAnchorElement | null;
    if (!anchor) {
      floatingTooltip.hideTooltip();
      currentTooltipTextRef.current = null;
      currentHoverHrefRef.current = null;
      currentHoverAnchorRef.current = null;
      return;
    }

    const linkType = anchor.getAttribute('data-linkify');
    if (linkType !== 'file') {
      floatingTooltip.hideTooltip();
      currentTooltipTextRef.current = null;
      currentHoverHrefRef.current = null;
      currentHoverAnchorRef.current = null;
      return;
    }

    const href = anchor.getAttribute('href');
    if (!href) {
      floatingTooltip.hideTooltip();
      currentTooltipTextRef.current = null;
      currentHoverHrefRef.current = null;
      currentHoverAnchorRef.current = null;
      return;
    }

    // Debounce: skip if the mouse is merely moving within the same <a>.
    // Rely on relatedTarget (the element the mouse came from) rather than
    // cross-event ref state, which can become stale when DOM is replaced.
    const relatedTarget = event.relatedTarget as HTMLElement | null;
    const relatedNode = relatedTarget as unknown as Node | null;
    const relatedElement = relatedNode?.nodeType === Node.TEXT_NODE
      ? (relatedNode as Text).parentElement
      : relatedTarget;
    const relatedAnchor = relatedElement?.closest('a');
    if (relatedAnchor === anchor) {
      return;
    }

    currentHoverHrefRef.current = href;
    currentHoverAnchorRef.current = anchor;

    const nativeEvt = event.nativeEvent as MouseEvent;
    latestMousePositionRef.current = {
      clientX: nativeEvt.clientX,
      clientY: nativeEvt.clientY,
    };

    if (lastTooltipHrefRef.current === href && currentTooltipTextRef.current) {
      floatingTooltip.moveTooltip(currentTooltipTextRef.current, nativeEvt.clientX, nativeEvt.clientY);
      return;
    }

    floatingTooltip.hideTooltip();
    currentTooltipTextRef.current = null;
    lastTooltipHrefRef.current = href;

    const showTooltip = (text: string) => {
      currentTooltipTextRef.current = text;
      const { clientX, clientY } = latestMousePositionRef.current;
      floatingTooltip.showTooltip(text, clientX, clientY);
    };

    const cachedText = resolvedTooltipTextRef.current.get(href);
    if (cachedText) {
      showTooltip(cachedText);
    }

    resolveFilePathWithCallback(href, (resolvedPath) => {
      if (!mountedRef.current || currentHoverHrefRef.current !== href) {
        return;
      }
      if (!resolvedPath) {
        // Backend could not produce a display path (e.g. no project root,
        // canonicalization failure). Fall back to the raw href so the tooltip
        // still tells the user where the link points — same policy as
        // useResolvedFileLinkTooltip.
        resolvedTooltipTextRef.current.delete(href);
        showTooltip(href);
        return;
      }

      resolvedTooltipTextRef.current.set(href, resolvedPath);
      showTooltip(resolvedPath);
    });
  }, [floatingTooltip]);

  const handleMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    // Only update position when a tooltip is visible and the mouse is
    // inside a file link.
    latestMousePositionRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (!currentTooltipTextRef.current || !currentHoverHrefRef.current) {
      return;
    }

    const target = event.target as HTMLElement;
    const targetNode = target as unknown as Node;
    const element = targetNode.nodeType === Node.TEXT_NODE
      ? (targetNode as Text).parentElement
      : target;
    const anchor = element?.closest('a') as HTMLAnchorElement | null;
    if (!anchor || anchor.getAttribute('data-linkify') !== 'file') {
      return;
    }

    floatingTooltip.moveTooltip(
      currentTooltipTextRef.current,
      event.clientX,
      event.clientY,
    );
  }, [floatingTooltip]);

  const handleMouseOut = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const relatedTarget = event.relatedTarget as HTMLElement | null;
    // Cast target to Node first so nodeType is readable on Text nodes.
    const targetNode = target as unknown as Node;
    const element = targetNode.nodeType === Node.TEXT_NODE
      ? (targetNode as Text).parentElement
      : target;
    const anchor = element?.closest('a') as HTMLAnchorElement | null;

    if (anchor && anchor.getAttribute('data-linkify') === 'file') {
      const relatedNode = relatedTarget as unknown as Node | null;
      const relatedElement = relatedNode?.nodeType === Node.TEXT_NODE
        ? (relatedNode as Text).parentElement
        : relatedTarget;
      const relatedAnchor = relatedElement?.closest('a');
      if (relatedAnchor !== anchor) {
        floatingTooltip.hideTooltip();
        currentTooltipTextRef.current = null;
        currentHoverHrefRef.current = null;
        currentHoverAnchorRef.current = null;
        // Note: we intentionally do NOT clear lastTooltipHrefRef or
        // resolvedTooltipTextRef here. During streaming, DOM replacement
        // causes rapid mouseout/mouseover cycles; keeping the cache lets
        // us avoid resetting the tooltip text to the raw href.
      }
    }
  }, [floatingTooltip]);

  return {
    handleMouseOver,
    handleMouseMove,
    handleMouseOut,
  };
}

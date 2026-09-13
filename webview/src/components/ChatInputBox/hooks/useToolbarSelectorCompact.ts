import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Collapse labels when left selectors would come within this many px of the send cluster. */
export const TOOLBAR_SELECTOR_MIN_GAP_PX = 10;

/**
 * Whether toolbar selector labels should collapse to icon-only mode.
 * Collapses when left content + right cluster + min gap would exceed the toolbar width.
 */
export function shouldCollapseToolbarSelectors(
  rootWidth: number,
  leftContentWidth: number,
  rightWidth: number,
  minGapPx: number = TOOLBAR_SELECTOR_MIN_GAP_PX,
): boolean {
  if (rootWidth <= 0 || leftContentWidth <= 0) return false;
  // Collapse when free space between left content and right cluster is ≤ minGap.
  // free = root - left - right; collapse when free <= minGap.
  return leftContentWidth + rightWidth + minGapPx >= rootWidth;
}

/**
 * Intrinsic width of the left selector cluster (sum of children + flex gap).
 * Do not use left.scrollWidth: left is flex:1 so scrollWidth tracks the stretched box.
 */
export function measureLeftContentWidth(left: HTMLElement): number {
  const children = left.children;
  if (children.length === 0) return 0;

  const styles = getComputedStyle(left);
  const gapRaw = styles.columnGap || styles.gap || '0';
  const gap = Number.parseFloat(gapRaw) || 0;

  let total = 0;
  for (let i = 0; i < children.length; i++) {
    total += (children[i] as HTMLElement).offsetWidth;
    if (i > 0) total += gap;
  }
  return total;
}

/** Content-box width of the toolbar (clientWidth minus horizontal padding). */
export function measureRootContentWidth(root: HTMLElement): number {
  const styles = getComputedStyle(root);
  const padL = Number.parseFloat(styles.paddingLeft) || 0;
  const padR = Number.parseFloat(styles.paddingRight) || 0;
  return Math.max(0, root.clientWidth - padL - padR);
}

/**
 * Measures expanded left content width. Temporarily sets `data-measuring` so CSS
 * can expand labels even while compact is active (avoids chicken-and-egg flicker).
 */
export function measureExpandedLeftWidth(root: HTMLElement, left: HTMLElement): number {
  root.setAttribute('data-measuring', '');
  // Force layout with expanded styles applied.
  const width = measureLeftContentWidth(left);
  root.removeAttribute('data-measuring');
  return width;
}

/**
 * Proximity-based toolbar compact mode for all CLI providers.
 * Hides selector labels when the left cluster would get within 10px of the send button.
 */
export function useToolbarSelectorCompact(
  rootRef: RefObject<HTMLElement | null>,
  leftRef: RefObject<HTMLElement | null>,
  rightRef: RefObject<HTMLElement | null>,
  /** Re-run when selector content may change (provider, model label, mode, etc.). */
  contentKey: string | number,
): boolean {
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(compact);
  compactRef.current = compact;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const left = leftRef.current;
    const right = rightRef.current;
    if (!root || !left || !right) return;

    let disposed = false;

    const recompute = () => {
      if (disposed) return;
      const rootEl = rootRef.current;
      const leftEl = leftRef.current;
      const rightEl = rightRef.current;
      if (!rootEl || !leftEl || !rightEl) return;

      // Always measure against expanded labels so compact/expand does not thrash.
      const leftWidth = measureExpandedLeftWidth(rootEl, leftEl);
      const needsCompact = shouldCollapseToolbarSelectors(
        measureRootContentWidth(rootEl),
        leftWidth,
        rightEl.offsetWidth,
      );

      if (needsCompact !== compactRef.current) {
        compactRef.current = needsCompact;
        setCompact(needsCompact);
      }
    };

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(recompute) : null;
    ro?.observe(root);
    ro?.observe(left);
    ro?.observe(right);

    window.addEventListener('resize', recompute);
    recompute();

    return () => {
      disposed = true;
      ro?.disconnect();
      window.removeEventListener('resize', recompute);
      root.removeAttribute('data-measuring');
    };
  }, [rootRef, leftRef, rightRef, contentKey]);

  return compact;
}

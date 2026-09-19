import { useEffect, type RefObject } from 'react';

/** Distance (px) from the container edge within which auto-scroll kicks in. */
const EDGE_ZONE_PX = 20;
/** Maximum scroll speed in px per animation frame. */
const MAX_SPEED_PX = 8;

/**
 * Compute the per-frame scroll delta for a pointer at `clientY` relative to
 * the container rect. Positive scrolls down, negative scrolls up, 0 means the
 * pointer is outside both edge zones. Speed ramps linearly with how deep the
 * pointer is inside the zone and keeps scrolling once it leaves the container.
 */
export function computeAutoScrollDelta(clientY: number, rect: { top: number; bottom: number }): number {
  const distanceFromTop = clientY - rect.top;
  const distanceFromBottom = rect.bottom - clientY;
  if (distanceFromTop < EDGE_ZONE_PX) {
    const depth = Math.min(EDGE_ZONE_PX, EDGE_ZONE_PX - distanceFromTop);
    return -Math.ceil((depth / EDGE_ZONE_PX) * MAX_SPEED_PX);
  }
  if (distanceFromBottom < EDGE_ZONE_PX) {
    const depth = Math.min(EDGE_ZONE_PX, EDGE_ZONE_PX - distanceFromBottom);
    return Math.ceil((depth / EDGE_ZONE_PX) * MAX_SPEED_PX);
  }
  return 0;
}

/**
 * Auto-scroll a fixed-height container while a pointer drag is active and the
 * pointer sits near (or beyond) its top/bottom edge. Complements
 * `useDragSort`, which resolves the drop target via `elementFromPoint` and has
 * no scrolling of its own, so rows outside the visible area would otherwise be
 * unreachable.
 *
 * @param containerRef Scrollable container (`overflow-y: auto`).
 * @param active Whether a drag is in progress; listeners and the rAF loop
 *               exist only while true.
 */
export function useDragAutoScroll(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }

    let pointerY: number | null = null;
    let frameId = 0;

    const onPointerMove = (event: PointerEvent) => {
      pointerY = event.clientY;
    };

    const tick = () => {
      const container = containerRef.current;
      if (container && pointerY !== null) {
        const delta = computeAutoScrollDelta(pointerY, container.getBoundingClientRect());
        if (delta !== 0) {
          container.scrollTop += delta;
        }
      }
      frameId = window.requestAnimationFrame(tick);
    };

    window.addEventListener('pointermove', onPointerMove);
    frameId = window.requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.cancelAnimationFrame(frameId);
    };
  }, [containerRef, active]);
}

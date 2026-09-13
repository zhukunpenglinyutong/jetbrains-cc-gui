/**
 * Get the #app element's bounding rect as the reference viewport.
 *
 * When #app has CSS zoom applied, using its rect ensures all coordinates
 * from getBoundingClientRect() on child elements are in the same space.
 * This avoids coordinate system mismatches between scaled and unscaled values.
 *
 * Also provides a `fixedPosDivisor` to compensate for CSS zoom on position:fixed elements.
 * Different Chromium/JCEF versions handle zoom differently:
 *   - Older: getBoundingClientRect() returns unzoomed CSS values, fixed positioning also unzoomed -> consistent, no fix needed.
 *   - Newer: getBoundingClientRect() returns zoomed viewport values, but fixed positioning values are scaled by zoom -> needs compensation.
 * Detection: if appRect.height ~ window.innerHeight while zoom != 1, we're in the "zoomed" variant.
 *
 * @returns Viewport dimensions, offsets, and fixedPosDivisor for zoom compensation
 */
export function getAppViewport(): {
  width: number;
  height: number;
  top: number;
  left: number;
  fixedPosDivisor: number;
} {
  const appEl = document.getElementById('app');
  const appRect = appEl?.getBoundingClientRect();
  const { zoom, gBCRisZoomed } = getZoomState(appEl, appRect);
  const height = appRect?.height ?? window.innerHeight;
  return {
    width: appRect?.width ?? window.innerWidth,
    height,
    top: appRect?.top ?? 0,
    left: appRect?.left ?? 0,
    fixedPosDivisor: gBCRisZoomed ? zoom : 1,
  };
}

/**
 * Internal: detect #app CSS zoom and whether getBoundingClientRect returns
 * zoom-scaled viewport values (newer Chromium/JCEF) or unzoomed layout
 * values (older builds). See getAppViewport for the detection rationale.
 */
function getZoomState(
  appEl: HTMLElement | null,
  appRect: DOMRect | undefined,
): { zoom: number; gBCRisZoomed: boolean } {
  const zoom = appEl ? parseFloat(getComputedStyle(appEl).zoom) || 1 : 1;
  if (zoom === 1) return { zoom: 1, gBCRisZoomed: false };
  const height = appRect?.height ?? window.innerHeight;
  return { zoom, gBCRisZoomed: Math.abs(height - window.innerHeight) < 2 };
}

/**
 * Logical (layout-space) top offset of `node` relative to the top edge of
 * `container`'s viewport. Use this instead of
 * `node.getBoundingClientRect().top - container.getBoundingClientRect().top`
 * whenever the delta is combined with `scrollTop`/`clientHeight`, which are
 * layout-space values: under #app CSS zoom != 1 on newer Chromium/JCEF,
 * getBoundingClientRect returns zoom-scaled viewport values, so the raw delta
 * is in the wrong unit. A scroll target computed from the raw delta lands
 * short by (1 - zoom) * remainingDistance on every click, converging only
 * over repeated clicks.
 */
export function getLogicalOffsetTop(node: HTMLElement, container: HTMLElement): number {
  const rawDelta = node.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const appEl = document.getElementById('app');
  const appRect = appEl?.getBoundingClientRect();
  const { zoom, gBCRisZoomed } = getZoomState(appEl, appRect);
  return gBCRisZoomed ? rawDelta / zoom : rawDelta;
}

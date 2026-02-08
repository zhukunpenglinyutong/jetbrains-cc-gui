/**
 * Get the #app element's bounding rect as the reference viewport.
 *
 * When #app has CSS zoom applied, using its rect ensures all coordinates
 * from getBoundingClientRect() on child elements are in the same space.
 * This avoids coordinate system mismatches between scaled and unscaled values.
 *
 * Also provides a `fixedPosDivisor` to compensate for CSS zoom on position:fixed elements.
 * Different Chromium/JCEF versions handle zoom differently:
 *   - Older: getBoundingClientRect() returns unzoomed CSS values, fixed positioning also unzoomed → consistent, no fix needed.
 *   - Newer: getBoundingClientRect() returns zoomed viewport values, but fixed positioning values are scaled by zoom → needs compensation.
 * Detection: if appRect.height ≈ window.innerHeight while zoom ≠ 1, we're in the "zoomed" variant.
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
  const zoomFactor = appEl ? parseFloat(getComputedStyle(appEl).zoom) || 1 : 1;
  const height = appRect?.height ?? window.innerHeight;
  // When zoom ≠ 1 and appRect.height matches window.innerHeight,
  // the browser returns zoomed values from getBoundingClientRect but
  // also scales position:fixed values by zoom, causing double-scaling.
  const needsCompensation = zoomFactor !== 1 && Math.abs(height - window.innerHeight) < 2;
  return {
    width: appRect?.width ?? window.innerWidth,
    height,
    top: appRect?.top ?? 0,
    left: appRect?.left ?? 0,
    fixedPosDivisor: needsCompensation ? zoomFactor : 1,
  };
}

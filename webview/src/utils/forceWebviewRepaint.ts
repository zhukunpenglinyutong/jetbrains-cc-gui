/**
 * forceWebviewRepaint
 *
 * Clears JCEF native-rendering ghosting on macOS by forcing a full-viewport
 * re-rasterization.
 *
 * Why this is needed: on macOS JCEF runs in native (windowed) rendering mode
 * (see JBCefBrowserFactory.determineOsrMode). In that mode Chromium's compositor
 * sometimes fails to invalidate the region a compositing-layer element occupied
 * after React unmounts it or its parent reflows — leaving stale pixels (ghosting).
 * Typical culprits: position:fixed/animated overlays (the changelog dialog) and
 * input-box header content that grows/shrinks (open-source banner, attachments).
 *
 * The fix reuses the zoom-nudge technique already proven in main.tsx `forceReapply`
 * ("Toggle inline zoom to ensure Chromium/JCEF re-applies scaling"), but applies it
 * unconditionally. The double requestAnimationFrame waits for React to finish the
 * unmount / reflow first, so the nudge erases the post-unmount viewport.
 *
 * @param _reason optional label for debugging; intentionally unused at runtime.
 */
export function forceWebviewRepaint(_reason?: string): void {
  const app = document.getElementById('app');
  if (!app) return;

  const appStyle = app.style as CSSStyleDeclaration & { zoom?: string };
  // Restore target: align with the scale main.tsx maintains via --font-scale.
  const expectedScale = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-scale')
    .trim();

  // Wait for React to finish unmount/reflow, THEN nudge, so we erase post-unmount pixels.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const restore = expectedScale || appStyle.zoom || '1';
      // Toggle inline zoom to force Chromium/JCEF to re-rasterize the whole viewport.
      appStyle.zoom = '1';
      void app.offsetHeight; // force synchronous layout
      appStyle.zoom = restore;
      // Let layout-dependent components recompute (mirrors main.tsx forceReapply).
      window.dispatchEvent(new Event('resize'));
    });
  });
}

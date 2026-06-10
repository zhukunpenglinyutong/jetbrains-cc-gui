/**
 * Scale recovery bootstrap module.
 *
 * JCEF (macOS) may occasionally render with an incorrect zoom/layout after the IDE
 * stays in background / screen-off for a while. The UI uses CSS `zoom` with an
 * inverse `vw/vh` container size to implement font scaling. If the zoom is not
 * applied correctly after resume, the container becomes smaller than the viewport,
 * leaving blank areas and causing "misalignment".
 *
 * This recovery nudges Chromium/JCEF to re-apply the expected zoom and triggers
 * a resize recalculation for components relying on window size.
 */
import { debugLog } from '../utils/debug';

type CSSStyleDeclarationWithZoom = CSSStyleDeclaration & { zoom: string };

function getExpectedScale(): string {
  const fromCss = getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim();
  if (fromCss) return fromCss;

  const savedLevel = localStorage.getItem('fontSizeLevel');
  const level = savedLevel ? parseInt(savedLevel, 10) : 3;
  const fontSizeLevel = level >= 1 && level <= 6 ? level : 3;
  const fontSizeMap: Record<number, number> = {
    1: 0.8,
    2: 0.9,
    3: 1.0,
    4: 1.1,
    5: 1.2,
    6: 1.4,
  };
  return String(fontSizeMap[fontSizeLevel] || 1.0);
}

export function initScaleRecovery() {
  let hiddenAt: number | null = null;
  let lastRecoveryAt = 0;
  let scheduled = false;
  const RECOVERY_COOLDOWN_MS = 1500;

  const forceReapply = (reason: string) => {
    const app = document.getElementById('app') as HTMLElement | null;
    const expected = getExpectedScale();

    // Re-set the CSS variable to ensure width/height calc(100vw/scale) is refreshed.
    document.documentElement.style.setProperty('--font-scale', expected);

    const computedZoom = app
      ? (getComputedStyle(app) as unknown as CSSStyleDeclarationWithZoom).zoom
      : null;
    const computedZoomNumber = typeof computedZoom === 'string' ? parseFloat(computedZoom) : Number.NaN;
    const expectedNumber = parseFloat(expected);

    const needsZoomNudge =
      !!app &&
      Number.isFinite(expectedNumber) &&
      (!Number.isFinite(computedZoomNumber) || Math.abs(computedZoomNumber - expectedNumber) > 0.01);

    if (app && needsZoomNudge) {
      const appStyle = app.style as unknown as CSSStyleDeclarationWithZoom;
      // Toggle inline zoom to ensure Chromium/JCEF re-applies scaling after resume.
      // Keep the final value aligned with the CSS variable.
      appStyle.zoom = '1';
      // Force a sync layout.
      void app.offsetHeight;
      appStyle.zoom = expected;
    }

    // Let components recompute layout (some rely on window resize).
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      if (app && needsZoomNudge) {
        const appStyle = app.style as unknown as CSSStyleDeclarationWithZoom;
        // One more tick to reduce flakiness on macOS/JCEF.
        appStyle.zoom = expected;
      }
      debugLog('[ScaleRecovery] Applied scale recovery:', {
        reason,
        expected,
        computedZoom,
        needsZoomNudge,
      });
      lastRecoveryAt = Date.now();
    });
  };

  const schedule = (reason: string) => {
    if (scheduled || Date.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      forceReapply(reason);
    });
  };

  const onVisibilityChange = () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }

    const elapsed = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = null;
    // Only nudge after a meaningful pause to avoid unnecessary work during normal tab switches.
    if (elapsed > 1500) {
      schedule('visibilitychange-resume');
    }
  };

  const onWindowFocus = () => {
    // Focus can return without a visibilitychange in some IDE/window states.
    schedule('window-focus');
  };

  const onPageShow = () => {
    // Helps if the page is restored from bfcache-like behavior.
    schedule('pageshow');
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('pageshow', onPageShow);

  const cleanup = () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('pageshow', onPageShow);
  };

  // Best-effort teardown to release listeners on navigation/unload.
  window.addEventListener('beforeunload', cleanup, { once: true });
  window.addEventListener('pagehide', cleanup, { once: true });

  if (import.meta.hot) {
    import.meta.hot.dispose(() => cleanup());
  }
}

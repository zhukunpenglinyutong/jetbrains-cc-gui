/**
 * Coalesces legacy generic JCEF ghosting recovery behind the tokenized OSR pulse.
 *
 * A request may be scheduled before a Java pulse begins, so pulse ownership is
 * checked again inside the actual timer/rAF callback. All inline-zoom writes are
 * delegated to surfaceDamagePulse; this module only owns scheduling and callback
 * coalescing.
 */
import {
  performGenericSurfaceDamage,
  runAfterSurfaceDamagePulse,
} from './surfaceDamagePulse';

let repaintScheduled = false;
let pendingCallbacks: Array<() => void> = [];

export function forceWebviewRepaint(_reason?: string, onRepaint?: () => void): void {
  if (onRepaint) {
    pendingCallbacks.push(onRepaint);
  }
  if (repaintScheduled) return;
  repaintScheduled = true;

  let completed = false;
  let fallbackId: number | undefined;
  const repaint = () => {
    if (completed) return;
    if (runAfterSurfaceDamagePulse(repaint)) return;

    const app = document.getElementById('app');
    if (!app) {
      completed = true;
      repaintScheduled = false;
      pendingCallbacks = [];
      return;
    }
    const expectedScale = getComputedStyle(document.documentElement)
      .getPropertyValue('--font-scale')
      .trim();
    if (!performGenericSurfaceDamage(app, expectedScale)) {
      runAfterSurfaceDamagePulse(repaint);
      return;
    }

    completed = true;
    if (fallbackId !== undefined) window.clearTimeout(fallbackId);
    repaintScheduled = false;
    const callbacks = pendingCallbacks;
    pendingCallbacks = [];
    callbacks.forEach((callback) => callback());
  };

  // Keep the double-rAF path for post-React layout. The timer only schedules the
  // generic mutation; the execution-time ownership check remains authoritative.
  fallbackId = window.setTimeout(repaint, 50);
  requestAnimationFrame(() => {
    requestAnimationFrame(repaint);
  });
}

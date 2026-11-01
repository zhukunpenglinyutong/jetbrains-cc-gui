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

/** Damage the client's viewport without changing editor geometry, focus, or IME selection. */
export function repaintRemoteWebview(): void {
  if (document.getElementById('ccgui-remote-repaint')) return;
  const overlay = document.createElement('div');
  overlay.id = 'ccgui-remote-repaint';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;background:rgba(0,0,0,0.004)';
  document.body.appendChild(overlay);
  const remove = () => overlay.remove();
  // The timer also releases the overlay if a backgrounded renderer suspends animation frames.
  const fallback = window.setTimeout(remove, 150);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.clearTimeout(fallback);
    remove();
  }));
}

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

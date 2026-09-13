import { sendBridgeEvent } from './bridge';

/**
 * Coordinates strict raster-sentinel pulses and legacy generic zoom repaints.
 *
 * The Java OSR frame fence owns a tokenized A/B pulse. Generic repaint work can
 * only mutate zoom while no pulse is active, and it rechecks that ownership at
 * execution time. Each phase reports an applied acknowledgment after its DOM
 * mutation and forced layout have run; Java never advances a paint gate merely
 * because executeJavaScript accepted a script for asynchronous execution.
 */

type SurfaceDamagePhase = 'A' | 'B';

interface ActiveSurfaceDamagePulse {
  token: string;
  sentinel: HTMLElement;
  phase: SurfaceDamagePhase;
}

let activePulse: ActiveSurfaceDamagePulse | null = null;
let nextSentinelVariant = 0;
const settledWaiters = new Set<() => void>();
const SENTINEL_ID = 'ccgui-surface-damage-sentinel';
const SENTINEL_COLORS = [
  'rgba(255, 0, 255, 0.01)',
  'rgba(0, 255, 255, 0.01)',
] as const;

function acknowledgePhase(token: string, phase: SurfaceDamagePhase, applied: boolean): void {
  sendBridgeEvent('surface_damage_applied', JSON.stringify({ token, phase, applied }));
}

function parseEffectiveScale(scale: string): number {
  const parsed = Number.parseFloat(scale || '1');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function relativeNudge(scale: string): string {
  return String(parseEffectiveScale(scale) * 0.999);
}

function getOrCreateSentinel(): HTMLElement | null {
  const existing = document.getElementById(SENTINEL_ID);
  if (existing) return existing;
  const parent = document.body ?? document.documentElement;
  if (!parent) return null;
  const sentinel = document.createElement('div');
  sentinel.id = SENTINEL_ID;
  sentinel.setAttribute('aria-hidden', 'true');
  Object.assign(sentinel.style, {
    position: 'fixed',
    top: '0',
    right: '0',
    width: '2px',
    height: '2px',
    pointerEvents: 'none',
    contain: 'strict',
    zIndex: '2147483647',
    backgroundColor: 'transparent',
  });
  parent.appendChild(sentinel);
  return sentinel;
}

function applySentinelColor(sentinel: HTMLElement, color: string): boolean {
  sentinel.style.backgroundColor = color;
  return getComputedStyle(sentinel).backgroundColor !== '';
}

function installPhaseA(token: string, sentinel: HTMLElement): boolean {
  const variant = nextSentinelVariant;
  nextSentinelVariant = (nextSentinelVariant + 1) % SENTINEL_COLORS.length;
  const applied = applySentinelColor(sentinel, SENTINEL_COLORS[variant]);
  activePulse = { token, sentinel, phase: 'A' };
  return applied;
}

function restoreSentinel(pulse: ActiveSurfaceDamagePulse): boolean {
  return applySentinelColor(pulse.sentinel, 'transparent');
}

function settlePulse(): void {
  activePulse?.sentinel.remove();
  activePulse = null;
  if (settledWaiters.size === 0) return;
  const waiters = Array.from(settledWaiters);
  settledWaiters.clear();
  queueMicrotask(() => {
    waiters.forEach((waiter) => waiter());
  });
}

/** Starts phase A only when no other Java attempt owns the raster sentinel. */
export function beginSurfaceDamagePulse(token: string): boolean {
  if (!token) {
    acknowledgePhase(token, 'A', false);
    return false;
  }
  const sentinel = getOrCreateSentinel();
  if (!sentinel) {
    acknowledgePhase(token, 'A', false);
    return false;
  }

  if (activePulse?.token === token) {
    const applied = activePulse.phase === 'A';
    acknowledgePhase(token, 'A', applied);
    return applied;
  }
  if (activePulse) {
    acknowledgePhase(token, 'A', false);
    return false;
  }

  const applied = installPhaseA(token, sentinel);
  acknowledgePhase(token, 'A', applied);
  return applied;
}

/**
 * Replaces one exact pulse owner with a newer Java attempt without releasing
 * generic repaint waiters between the two owners.
 */
export function replaceSurfaceDamagePulse(previousToken: string, nextToken: string): boolean {
  const pulse = activePulse;
  if (!pulse || pulse.token !== previousToken || !nextToken) {
    acknowledgePhase(nextToken, 'A', false);
    return false;
  }
  if (previousToken === nextToken) {
    const applied = pulse.phase === 'A';
    acknowledgePhase(nextToken, 'A', applied);
    return applied;
  }

  const applied = installPhaseA(nextToken, pulse.sentinel);
  acknowledgePhase(nextToken, 'A', applied);
  return applied;
}

/** Restores phase A and acknowledges Phase B after the mutation is applied. */
export function advanceSurfaceDamagePulse(token: string): boolean {
  const pulse = activePulse;
  if (!pulse || pulse.token !== token || pulse.phase !== 'A') {
    acknowledgePhase(token, 'B', false);
    return false;
  }
  pulse.phase = 'B';
  const applied = restoreSentinel(pulse);
  acknowledgePhase(token, 'B', applied);
  return applied;
}

/** Releases coordinator ownership after Java publishes the final full frame. */
export function finishSurfaceDamagePulse(token: string): boolean {
  const pulse = activePulse;
  if (!pulse || pulse.token !== token || pulse.phase !== 'B') return false;
  settlePulse();
  return true;
}

/** Cancels either the current attempt or its exact replacement predecessor. */
export function cancelSurfaceDamagePulse(token: string, predecessorToken?: string): boolean {
  const pulse = activePulse;
  if (!pulse || (pulse.token !== token && pulse.token !== predecessorToken)) return false;
  if (pulse.phase === 'A') {
    restoreSentinel(pulse);
  }
  settlePulse();
  return true;
}

export function isSurfaceDamagePulseActive(): boolean {
  return activePulse !== null;
}

/** Defers generic zoom work until the exact Java sentinel owner relinquishes it. */
export function runAfterSurfaceDamagePulse(waiter: () => void): boolean {
  if (!activePulse) return false;
  settledWaiters.add(waiter);
  return true;
}

/**
 * Performs one generic zoom nudge while the coordinator is unowned.
 * The caller must retry later when this returns false.
 */
export function performGenericSurfaceDamage(app: HTMLElement, restoreScale: string): boolean {
  if (activePulse) return false;
  const appStyle = app.style as CSSStyleDeclaration & { zoom?: string };
  const restore = restoreScale || appStyle.zoom || '1';
  appStyle.zoom = relativeNudge(restore);
  void app.offsetHeight;
  appStyle.zoom = restore;
  window.dispatchEvent(new Event('resize'));
  return true;
}

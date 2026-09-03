import { useCallback, useRef } from 'react';

/**
 * A stable callback that forwards to whatever function a LATER-constructed
 * hook assigns (Story 1.3 review D2). `useModelProviderState` runs before
 * `useSessionManagement`, so the early hook receives the stable `call` up
 * front and App points the trampoline at `forceCreateNewSession` once the
 * later hook exists — render-time assignment, the same pattern as
 * `currentProviderRef`. Until the first assignment `call` is a safe no-op.
 */
export interface LateBoundCallback<Args extends unknown[] = []> {
  /** Stable-identity forwarder; safe (no-op) before the first assignment. */
  call: (...args: Args) => void;
  /** Point the trampoline at a (new) implementation. */
  set: (fn: (...args: Args) => void) => void;
}

export function useLateBoundCallback<Args extends unknown[] = []>(): LateBoundCallback<Args> {
  const ref = useRef<(...args: Args) => void>(() => {});
  const call = useCallback((...args: Args) => ref.current(...args), []);
  const set = useCallback((fn: (...args: Args) => void) => {
    ref.current = fn;
  }, []);
  return { call, set };
}

import { useSyncExternalStore } from 'react';

/**
 * Reactively tracks the `data-theme` attribute on <html> so React components can
 * adapt their rendering to the active UI theme without forcing a reload.
 *
 * This exists so the CoDriver skin can scope its bespoke iconography / layout to
 * the `codriver` theme only — light / dark / system keep the stock plugin look.
 */
function getThemeAttribute(): string {
  if (typeof document === 'undefined') {
    return '';
  }
  return document.documentElement.getAttribute('data-theme') || '';
}

function subscribe(onChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}

/** Returns the current `data-theme` attribute value (e.g. 'light' | 'dark' | 'codriver'). */
export function useActiveThemeMode(): string {
  return useSyncExternalStore(subscribe, getThemeAttribute, () => '');
}

/** Convenience helper: true only when the CoDriver skin is the active theme. */
export function useIsCoDriverTheme(): boolean {
  return useActiveThemeMode() === 'codriver';
}

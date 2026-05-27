// hooks/useWindowOpacity.ts
import { useState, useEffect, useRef } from 'react';

const STORAGE_KEY = 'windowOpacity';
const CSS_PROP = '--window-opacity';
const DEFAULT = 1.0;

function readStored(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT;
  const val = parseFloat(raw);
  if (!Number.isFinite(val)) return DEFAULT;
  return Math.max(0, Math.min(1, val));
}

function applyToCSS(value: number) {
  if (value < 1.0) {
    document.documentElement.style.setProperty(CSS_PROP, value.toString());
  } else {
    document.documentElement.style.removeProperty(CSS_PROP);
  }
}

function persist(value: number) {
  if (value < 1.0) {
    localStorage.setItem(STORAGE_KEY, value.toString());
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export interface UseWindowOpacityReturn {
  /** Current opacity value (0.0–1.0) */
  opacity: number;
  /** Set opacity — applies to CSS immediately, debounces localStorage */
  setOpacity: (v: number) => void;
  /** Reset to 1.0 */
  reset: () => void;
}

/**
 * Unified window opacity hook.
 *
 * - Initializes from `localStorage` on mount
 * - Applies CSS `--window-opacity` in real-time
 * - Debounces localStorage writes (500ms) to reduce I/O
 *
 * Safe to call from multiple hooks/components — reads/writes
 * the same CSS variable and storage key.
 */
export function useWindowOpacity(debounceMs = 500): UseWindowOpacityReturn {
  const [opacity, setOpacityState] = useState<number>(readStored);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply CSS variable and debounced localStorage on every opacity change
  useEffect(() => {
    applyToCSS(opacity);

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      persist(opacity);
      timerRef.current = null;
    }, debounceMs);
  }, [opacity, debounceMs]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const setOpacity = (v: number) => {
    const clamped = !Number.isFinite(v) ? DEFAULT : Math.max(0, Math.min(1, v));
    setOpacityState(clamped);
  };

  const reset = () => setOpacityState(DEFAULT);

  return { opacity, setOpacity, reset };
}

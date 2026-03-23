/**
 * F-007: In-memory ring buffer for diagnostic events.
 * Stores the last `maxAgeMs` (default 60s) of key events.
 * Uses refs only — zero re-renders.
 *
 * Supports freeze/unfreeze: when frozen, getEvents() returns the snapshot
 * taken at freeze time. New events keep flowing into the live buffer so
 * it stays populated after unfreeze.
 */

import { useCallback, useRef } from 'react';

export interface DiagnosticEvent {
  ts: number;
  type: string;
  data?: Record<string, unknown>;
}

/** Type alias for external consumers (e.g. useDiagnostics) */
export type DiagnosticRingBuffer = UseDiagnosticRingBufferReturn;

export interface UseDiagnosticRingBufferReturn {
  /** Push an event into the buffer. No-op when disabled. */
  pushEvent: (type: string, data?: Record<string, unknown>) => void;
  /** Get a copy of all buffered events (frozen snapshot if frozen, live otherwise). */
  getEvents: () => DiagnosticEvent[];
  /** Clear all buffered events. */
  clear: () => void;
  /** Freeze: snapshot current events. getEvents() returns this snapshot until unfreeze. */
  freeze: () => void;
  /** Unfreeze: discard snapshot, getEvents() returns live buffer again. */
  unfreeze: () => void;
}

const DEFAULT_MAX_AGE_MS = 60_000;
const DEFAULT_MAX_SIZE = 500;

export function useDiagnosticRingBuffer(
  enabled: boolean,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  maxSize: number = DEFAULT_MAX_SIZE,
): UseDiagnosticRingBufferReturn {
  const bufferRef = useRef<DiagnosticEvent[]>([]);
  const frozenRef = useRef<DiagnosticEvent[] | null>(null);

  const pushEvent = useCallback(
    (type: string, data?: Record<string, unknown>) => {
      if (!enabled) return;

      const now = Date.now();
      const buffer = bufferRef.current;

      // Append
      buffer.push({ ts: now, type, data });

      // Evict old entries from front
      const cutoff = now - maxAgeMs;
      while (buffer.length > 0 && buffer[0].ts < cutoff) {
        buffer.shift();
      }

      // Cap size
      while (buffer.length > maxSize) {
        buffer.shift();
      }
    },
    [enabled, maxAgeMs, maxSize],
  );

  const getEvents = useCallback((): DiagnosticEvent[] => {
    return frozenRef.current ?? [...bufferRef.current];
  }, []);

  const clear = useCallback(() => {
    bufferRef.current = [];
    frozenRef.current = null;
  }, []);

  const freeze = useCallback(() => {
    frozenRef.current = [...bufferRef.current];
  }, []);

  const unfreeze = useCallback(() => {
    frozenRef.current = null;
  }, []);

  return { pushEvent, getEvents, clear, freeze, unfreeze };
}

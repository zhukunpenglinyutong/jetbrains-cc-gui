/**
 * Pending-stream-start marker.
 *
 * Bridges the gap between a dispatched send and the turn's first
 * [STREAM_START]: during that window the backend may still emit late
 * cleanup events for a turn the user just interrupted (showLoading(false) /
 * onStreamEnd echoes arriving after the process tree kill completes).
 * Without the marker those echoes reset `loading` while the freshly
 * dispatched turn is actually booting, which makes the message-queue drain
 * effect dispatch the NEXT queued item and overlap two live turns on one
 * Codex thread (thread-writer lock conflict / ghost user bubble).
 *
 * Marked by the send path (executeMessage), cleared when the dispatched
 * turn's stream actually starts or when a genuine error snapshot lands.
 * Only cleanup immunity is time-boxed. Keep the submission identity until a
 * terminal event retires it: a large error snapshot can arrive after immunity
 * expires, following the only loading reset that was suppressed during boot.
 */

import { sendBridgeEvent } from './bridge';

const PENDING_STREAM_IMMUNITY_MS = 8000;

/** Bridge event asking the backend to re-send its real loading state. */
export const SYNC_LOADING_STATE_EVENT = 'sync_loading_state';

let loadingResyncTimer: ReturnType<typeof setTimeout> | null = null;
let loadingResyncMarkedAt: number | undefined;

declare global {
  interface Window {
    __pendingStreamStartAt?: number;
    __pendingStreamClientMessageId?: string;
  }
}

function cancelLoadingResync(): void {
  if (loadingResyncTimer) {
    clearTimeout(loadingResyncTimer);
  }
  loadingResyncTimer = null;
  loadingResyncMarkedAt = undefined;
}

export function markPendingStreamStart(clientMessageId?: string): void {
  cancelLoadingResync();
  window.__pendingStreamStartAt = Date.now();
  window.__pendingStreamClientMessageId = clientMessageId;
}

export function clearPendingStreamStart(): void {
  cancelLoadingResync();
  window.__pendingStreamStartAt = undefined;
  window.__pendingStreamClientMessageId = undefined;
}

/**
 * Whether late backend cleanup echoes must not reset the loading state right
 * now: a dispatched turn is still waiting for its stream to start.
 */
export function isPendingStreamStartActive(): boolean {
  const since = window.__pendingStreamStartAt;
  if (since == null) {
    return false;
  }
  return Date.now() - since < PENDING_STREAM_IMMUNITY_MS;
}

/**
 * A loading reset swallowed during the immunity window may have been the
 * dispatched turn's own and only one: a turn that ends or fails before any
 * [STREAM_START] (streaming disabled, a send failure reported only as a
 * status or toast) never sends another, so `loading` stayed true and every
 * later message waited in the queue. Replaying the swallowed reset is not
 * safe either — it may have been an older turn's echo while this one still
 * boots. So once the window closes with the turn still not streaming, ask the
 * backend for its loading state; its answer is no longer suppressed.
 */
export function scheduleLoadingResyncAfterImmunity(): void {
  const markedAt = window.__pendingStreamStartAt;
  if (markedAt == null || loadingResyncMarkedAt === markedAt) {
    return;
  }
  cancelLoadingResync();
  loadingResyncMarkedAt = markedAt;
  const delay = Math.max(0, markedAt + PENDING_STREAM_IMMUNITY_MS - Date.now());
  loadingResyncTimer = setTimeout(() => {
    loadingResyncTimer = null;
    loadingResyncMarkedAt = undefined;
    // A started stream or a newer send owns the loading state now.
    if (window.__pendingStreamStartAt !== markedAt) {
      return;
    }
    sendBridgeEvent(SYNC_LOADING_STATE_EVENT);
  }, delay);
}

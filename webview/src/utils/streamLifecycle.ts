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

const PENDING_STREAM_IMMUNITY_MS = 8000;

declare global {
  interface Window {
    __pendingStreamStartAt?: number;
    __pendingStreamClientMessageId?: string;
  }
}

export function markPendingStreamStart(clientMessageId?: string): void {
  window.__pendingStreamStartAt = Date.now();
  window.__pendingStreamClientMessageId = clientMessageId;
}

export function clearPendingStreamStart(): void {
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

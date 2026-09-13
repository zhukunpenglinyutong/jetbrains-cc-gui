/**
 * Fire bridge messages in small batches so opening Settings does not stampede
 * the Java/CEF bridge on a single frame.
 *
 * First batch runs synchronously (for fields needed on first paint). Remaining
 * batches run after a short delay (or requestIdleCallback when available).
 */

export type ScheduleBatchedBridgeRequestsOptions = {
  /** Messages to send, in priority order. */
  messages: readonly string[];
  /** How many messages to send per batch. Default: 5. */
  batchSize?: number;
  /** Delay between deferred batches in ms when idle callback is unavailable. Default: 16. */
  batchDelayMs?: number;
  send?: (message: string) => void;
};

export type ScheduledBridgeRequestsHandle = {
  cancel: () => void;
};

type IdleDeadlineLike = { didTimeout: boolean; timeRemaining: () => number };
type IdleCallback = (deadline: IdleDeadlineLike) => void;

function defaultSend(message: string): void {
  if (typeof window !== 'undefined' && typeof window.sendToJava === 'function') {
    window.sendToJava(message);
  }
}

function scheduleDeferred(run: () => void, delayMs: number): () => void {
  const win = typeof window !== 'undefined' ? (window as Window & {
    requestIdleCallback?: (cb: IdleCallback, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  }) : undefined;

  if (win?.requestIdleCallback) {
    const id = win.requestIdleCallback(() => run(), { timeout: Math.max(delayMs, 50) });
    return () => {
      win.cancelIdleCallback?.(id);
    };
  }

  const timer = setTimeout(run, delayMs);
  return () => {
    clearTimeout(timer);
  };
}

/**
 * @returns cancel handle — call on unmount to drop in-flight deferred batches.
 */
export function scheduleBatchedBridgeRequests(
  options: ScheduleBatchedBridgeRequestsOptions,
): ScheduledBridgeRequestsHandle {
  const {
    messages,
    batchSize = 5,
    batchDelayMs = 16,
    send = defaultSend,
  } = options;

  if (messages.length === 0) {
    return { cancel: () => undefined };
  }

  let cancelled = false;
  let index = 0;
  let cancelScheduled: (() => void) | null = null;

  const flushBatch = () => {
    if (cancelled) return;
    const end = Math.min(index + batchSize, messages.length);
    for (; index < end; index += 1) {
      send(messages[index]!);
    }
    if (index < messages.length) {
      cancelScheduled = scheduleDeferred(flushBatch, batchDelayMs);
    } else {
      cancelScheduled = null;
    }
  };

  // First batch immediately so Environment / Behavior critical fields still populate fast.
  flushBatch();

  return {
    cancel: () => {
      cancelled = true;
      cancelScheduled?.();
      cancelScheduled = null;
    },
  };
}

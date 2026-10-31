/**
 * Window callbacks for steer receipts and live provider capabilities.
 */

import type { MutableRefObject } from 'react';
import type { TFunction } from 'i18next';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage, ClaudeRawMessage } from '../../../types';
import {
  clearSteerPending,
  getSteerIdOf,
  removeSteeredMessage,
} from '../../../utils/steerMessages';
import { debugError } from '../../../utils/debug';

interface SteerResultPayload {
  steerId?: string;
  status?: string;
  reason?: string;
}

interface SteerFoldedPayload {
  steerId?: string;
  message?: {
    type?: string;
    content?: string;
    timestamp?: number | string;
    raw?: ClaudeRawMessage;
  };
}

/**
 * Backstop for a steer receipt that never arrives: the daemon steer command
 * times out after 10s (ClaudeSDKBridge.steerLive), so if no accepted/rejected
 * receipt reached this window 15s after dispatch, settle the steer as
 * rejected (reason 'timeout') through the normal receipt path. Without this,
 * a dispatch exception swallowed before the daemon call (e.g. session not
 * built yet) would strand the bubble in `steering` and keep the queue row
 * hidden forever.
 */
const STEER_RECEIPT_TIMEOUT_MS = 15_000;
/**
 * After `accepted`, the dispatch backstop is disarmed but the fold is still
 * outstanding. A fold tag lost on the way back (event dropped, or a turn torn
 * down mid-fold) would hide the queue row and spin the bubble forever, so
 * settle it here instead. This settles as *delivered*: the CLI already took the
 * message, and requeueing it would execute the same prompt twice.
 */
const STEER_FOLD_TIMEOUT_MS = 90_000;
/** Pending backstop timer handle (number in the DOM build, Timeout under Node types). */
type SteerReceiptTimer = ReturnType<typeof setTimeout>;
const steerReceiptTimers = new Map<string, SteerReceiptTimer>();
const steerFoldTimers = new Map<string, SteerReceiptTimer>();

function disarmSteerReceiptTimeout(steerId: string): void {
  const timer = steerReceiptTimers.get(steerId);
  if (timer !== undefined) {
    clearTimeout(timer);
    steerReceiptTimers.delete(steerId);
  }
}

function disarmSteerFoldTimeout(steerId: string): void {
  const timer = steerFoldTimers.get(steerId);
  if (timer !== undefined) {
    clearTimeout(timer);
    steerFoldTimers.delete(steerId);
  }
}

/**
 * Start the fold backstop for a steer the CLI has accepted.
 *
 * @param steerId frontend correlation id
 * @param onExpire settles the steer once the fold never arrives
 */
function armSteerFoldTimeout(steerId: string, onExpire: () => void): void {
  if (!steerId) return;
  disarmSteerFoldTimeout(steerId);
  steerFoldTimers.set(steerId, setTimeout(() => {
    steerFoldTimers.delete(steerId);
    debugError(`[Steer] no fold within ${STEER_FOLD_TIMEOUT_MS}ms steerId=${steerId}`);
    onExpire();
  }, STEER_FOLD_TIMEOUT_MS));
}

/**
 * Drop every pending receipt backstop. Called on a session switch: the steer
 * belongs to the previous session, and its (now meaningless) timeout must not
 * fire a reject toast into the freshly opened one.
 */
export function clearSteerReceiptTimeouts(): void {
  for (const timer of steerReceiptTimers.values()) {
    clearTimeout(timer);
  }
  steerReceiptTimers.clear();
  for (const timer of steerFoldTimers.values()) {
    clearTimeout(timer);
  }
  steerFoldTimers.clear();
}

/**
 * Start the receipt backstop for a freshly dispatched steer.
 *
 * @param steerId frontend correlation id
 */
export function armSteerReceiptTimeout(steerId: string): void {
  if (!steerId) return;
  disarmSteerReceiptTimeout(steerId);
  steerReceiptTimers.set(steerId, setTimeout(() => {
    steerReceiptTimers.delete(steerId);
    debugError(`[Steer] no receipt within ${STEER_RECEIPT_TIMEOUT_MS}ms steerId=${steerId}`);
    window.onSteerResult?.(JSON.stringify({ steerId, status: 'rejected', reason: 'timeout' }));
  }, STEER_RECEIPT_TIMEOUT_MS));
}

/**
 * Convert the Java fold payload into a frontend user message.
 *
 * @param payload folded steer payload
 * @returns steered user message
 */
function toSteeredUserMessage(payload: SteerFoldedPayload): ClaudeMessage {
  const source = payload.message;
  const timestamp = typeof source?.timestamp === 'number'
    ? new Date(source.timestamp).toISOString()
    : (typeof source?.timestamp === 'string' ? source.timestamp : new Date().toISOString());
  const raw: ClaudeRawMessage = {
    ...(source?.raw && typeof source.raw === 'object' ? source.raw : {}),
    steered: true,
    steerId: payload.steerId,
  };
  return {
    type: 'user',
    content: typeof source?.content === 'string' ? source.content : '',
    timestamp,
    steered: true,
    steerId: payload.steerId,
    raw,
  };
}

/**
 * Register onSteerResult / onSteerFolded / onProviderCapabilities.
 *
 * @param options window callback options
 * @param tRef live translator for reject toasts
 */
export function registerSteerCallbacks(
  options: UseWindowCallbacksOptions,
  tRef: MutableRefObject<TFunction>,
): void {
  window.onSteerResult = (json: string) => {
    try {
      const payload = JSON.parse(json) as SteerResultPayload;
      const api = options.messageQueueSteerRef?.current;
      const steerId = payload.steerId;
      if (!api || !steerId) return;
      disarmSteerReceiptTimeout(steerId);
      if (payload.status === 'accepted') {
        // Idempotent: the click already flipped the row. A duplicate accept for
        // a row another receipt restored must neither re-hide it nor arm a
        // backstop that would later dequeue a row that is live again.
        if (api.isSteering(steerId)) {
          api.markSteering(steerId);
          armSteerFoldTimeout(steerId, () => {
            const liveApi = options.messageQueueSteerRef?.current;
            if (!liveApi?.isSteering(steerId)) return;
            liveApi.dequeue(steerId);
            options.setMessages((prev) => clearSteerPending(prev, steerId));
            // Never silent: the row left the queue, so say what was assumed.
            options.addToast(
              tRef.current('chat.steerUnconfirmed', {
                defaultValue: 'A steered message was accepted but never confirmed by the model turn; it was treated as delivered.',
              }),
              'warning',
            );
          });
        }
        return;
      }
      // Every terminal receipt also settles the fold backstop.
      disarmSteerFoldTimeout(steerId);
      if (payload.status === 'rejected') {
        // The bubble was inserted optimistically on click and the CLI never
        // took the steer: retract it and put the row back in the queue.
        // restore() only flips a row still in queue state; when the receipt
        // outlived it (e.g. a session transition cleared the queue), the
        // fallback rebuilt from the bubble takes its place (steer plan F1).
        const fallback = api.findSteeredBubble(steerId) ?? undefined;
        options.setMessages((prev) => removeSteeredMessage(prev, steerId));
        api.restore(steerId, fallback);
        const reason = payload.reason || 'no_active_turn';
        const message = tRef.current(`chat.steerRejected.${reason}`, { defaultValue: reason });
        options.addToast(message, 'warning');
        return;
      }
      if (payload.status === 'undelivered') {
        // The turn ended before the CLI took the steer: put the message back
        // where the user can see it instead of dropping it silently.
        const item = api.steeringItemsRef.current.get(steerId);
        const fallback = item ?? api.findSteeredBubble(steerId);
        options.setMessages((prev) => removeSteeredMessage(prev, steerId));
        if (fallback) {
          api.requeueAtHead(fallback);
          // The turn ended before the CLI took the steer; say so instead of
          // silently swallowing the message (TC-07 expects visible feedback).
          options.addToast(
            tRef.current('chat.steerUndelivered', {
              defaultValue: 'A steered message was not delivered and has been moved back to the head of the queue.',
            }),
            'warning',
          );
        } else {
          // Never silent (steer plan F1): neither the steering map nor the
          // transcript bubble could recover the message.
          debugError(`[Steer] undelivered receipt could not recover steerId=${steerId}`);
          options.addToast(
            tRef.current('chat.steerUndeliveredLost', {
              defaultValue: 'A steered message was not delivered and could not be restored to the queue.',
            }),
            'warning',
          );
        }
      }
    } catch {
      // Ignore malformed steer receipts
    }
  };

  window.onSteerFolded = (json: string) => {
    try {
      const payload = JSON.parse(json) as SteerFoldedPayload;
      const steerId = payload.steerId;
      // Disarm before the transition guard: a fold arriving while a session is
      // closing still settles this steer, and leaving its timers armed would
      // fire them against the session being opened.
      if (steerId) {
        disarmSteerReceiptTimeout(steerId);
        disarmSteerFoldTimeout(steerId);
      }
      // A fold that lands mid-transition belongs to the session being closed:
      // appending it to the freshly cleared transcript would leave a ghost row
      // plus an assistant placeholder that no delta will ever close.
      if (window.__sessionTransitioning) {
        return;
      }
      const api = options.messageQueueSteerRef?.current;
      if (api && steerId) {
        api.dequeue(steerId);
      }
      const nextTurnId = options.turnIdCounterRef.current + 1;
      options.turnIdCounterRef.current = nextTurnId;
      options.streamingTurnIdRef.current = nextTurnId;
      options.streamingContentRef.current = '';
      options.streamingThinkingRef.current = '';
      options.setMessages((prev) => {
        const alreadyPresent = !!steerId && prev.some((message) => (
          message.type === 'user' && getSteerIdOf(message) === steerId
        ));
        // Segment 1 is complete at the fold; later deltas belong to the placeholder.
        const settled = prev.map((message) => (
          message.type === 'assistant' && message.isStreaming
            ? { ...message, isStreaming: false }
            : message
        ));
        // The optimistic bubble was already on screen: only clear its pending
        // marker, otherwise insert the row we never showed.
        const withDeliveredRow = alreadyPresent
          ? clearSteerPending(settled, steerId as string)
          : settled;
        const steeredUser = alreadyPresent ? null : toSteeredUserMessage(payload);
        const placeholder: ClaudeMessage = {
          type: 'assistant',
          content: '',
          isStreaming: true,
          __turnId: nextTurnId,
          timestamp: new Date().toISOString(),
        };
        const next = alreadyPresent
          ? [...withDeliveredRow, placeholder]
          : [...withDeliveredRow, steeredUser as ClaudeMessage, placeholder];
        options.streamingMessageIndexRef.current = next.length - 1;
        return next;
      });
    } catch {
      // Ignore malformed fold payloads
    }
  };

  window.onProviderCapabilities = (json: string) => {
    try {
      const payload = JSON.parse(json) as { steer?: boolean };
      options.applyCapabilitiesRef?.current?.({ steer: !!payload.steer });
    } catch {
      // Ignore malformed capability payloads
    }
  };
}

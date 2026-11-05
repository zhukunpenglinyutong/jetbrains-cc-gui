import { useCallback, useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import type { PermissionRequest } from '../components/PermissionDialog';
import type { AskUserQuestionRequest } from '../components/AskUserQuestionDialog';
import type { ToastMessage } from '../components/Toast';

const SUBMITTED_ANSWER_LIMIT = 64;

export type SubmittedCodexAnswer =
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'question'; request: AskUserQuestionRequest };

interface UseCodexDeliveryRecoveryOptions {
  t: TFunction;
  addToast?: (message: string, type?: ToastMessage['type']) => void;
  reopen: (answer: SubmittedCodexAnswer) => void;
}

interface DeliveryAcknowledgement {
  interactionKey: string;
  error: string | null;
  retryable: boolean;
  /** Java gave up waiting for the daemon; the answer may still take effect. */
  unconfirmed: boolean;
}

function readAcknowledgement(detail: unknown): DeliveryAcknowledgement | null {
  try {
    const ack = typeof detail === 'string' ? JSON.parse(detail) : detail;
    if (!ack || typeof ack !== 'object' || typeof ack.interactionKey !== 'string') return null;
    return {
      interactionKey: ack.interactionKey,
      error: typeof ack.error === 'string' && ack.error ? ack.error : null,
      retryable: ack.retryable !== false,
      unconfirmed: ack.deliveryUnconfirmed === true,
    };
  } catch {
    return null;
  }
}

/**
 * Brings a Codex dialog back when its answer never reached the native runtime.
 *
 * Dialogs close as soon as the page hands an answer to Java. When Java then
 * fails to deliver it (stale interaction, daemon unavailable, rejected
 * result), Codex keeps waiting on a request the user can no longer see and the
 * turn looks stuck. Java reports every outcome through
 * `codex-interaction-response`; on failure the request is reopened once so the
 * user can answer again. A second failure, a failure Java marks as not
 * retryable, or a deadline that has already passed only explains what
 * happened: reopening then would just fail again or auto-deny on the spot.
 * An answer Java merely stopped waiting for (`deliveryUnconfirmed`) is never
 * reopened either: a slow daemon usually delivers it late, and a second,
 * different answer would be rejected while the first one takes effect.
 * Answers whose dialog the runtime closed in the meantime are forgotten, so a
 * late failure never resurrects a request that already ended.
 *
 * @returns callbacks that record an answer the page just sent, and forget
 *   answers whose dialog the runtime has closed
 */
export function useCodexDeliveryRecovery({ t, addToast, reopen }: UseCodexDeliveryRecoveryOptions) {
  const submittedRef = useRef(new Map<string, SubmittedCodexAnswer>());
  const reopenedRef = useRef(new Set<string>());
  const optionsRef = useRef({ t, addToast, reopen });
  useEffect(() => {
    optionsRef.current = { t, addToast, reopen };
  }, [t, addToast, reopen]);

  useEffect(() => {
    const handleAcknowledgement = (event: Event) => {
      const ack = readAcknowledgement((event as CustomEvent).detail);
      const submitted = ack ? submittedRef.current.get(ack.interactionKey) : undefined;
      if (!ack || !submitted) return;
      submittedRef.current.delete(ack.interactionKey);
      if (ack.error === null) return;

      const { deadlineMs } = submitted.request;
      const expired = typeof deadlineMs === 'number' && deadlineMs > 0 && deadlineMs <= Date.now();
      const canRetry = ack.retryable && !expired && !reopenedRef.current.has(ack.interactionKey);
      const { t: translate, addToast: notify, reopen: reopenDialog } = optionsRef.current;
      const messageKey = canRetry ? 'permission.codexDeliveryRetry'
        : ack.unconfirmed ? 'permission.codexDeliveryUnconfirmed'
          : 'permission.codexDeliveryFailed';
      notify?.(translate(messageKey, { error: ack.error }), 'error');
      if (!canRetry) return;
      reopenedRef.current.add(ack.interactionKey);
      reopenDialog(submitted);
    };
    window.addEventListener('codex-interaction-response', handleAcknowledgement);
    return () => window.removeEventListener('codex-interaction-response', handleAcknowledgement);
  }, []);

  const rememberCodexAnswer = useCallback((answer: SubmittedCodexAnswer) => {
    const key = answer.request.codexInteractionKey;
    if (!key) return;
    const submitted = submittedRef.current;
    submitted.delete(key);
    submitted.set(key, answer);
    if (submitted.size > SUBMITTED_ANSWER_LIMIT) {
      submitted.delete(submitted.keys().next().value!);
    }
  }, []);

  const forgetCodexAnswers = useCallback((matches: (answer: SubmittedCodexAnswer) => boolean) => {
    for (const [key, answer] of submittedRef.current) {
      if (matches(answer)) submittedRef.current.delete(key);
    }
  }, []);

  return { rememberCodexAnswer, forgetCodexAnswers };
}

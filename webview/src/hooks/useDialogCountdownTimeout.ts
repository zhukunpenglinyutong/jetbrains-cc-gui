import { useCallback, useEffect, useRef, useState } from 'react';

const WARNING_THRESHOLD_SECONDS = 30;

interface UseDialogCountdownTimeoutOptions {
  isOpen: boolean;
  requestKey?: string | null;
  timeoutSeconds: number;
  deadlineMs?: number;
  timeoutEnabled?: boolean;
  /** Return `false` when the timeout decision could not be sent (refused bridge
   * write); the dialog then re-arms instead of deadlocking on the next click. */
  onTimeout: () => void | boolean;
}

interface UseDialogCountdownTimeoutReturn {
  remainingSeconds: number;
  isTimeWarning: boolean;
  isTimedOut: boolean;
  markSubmitted: () => boolean;
  restoreSubmission: () => void;
}

export function useDialogCountdownTimeout({
  isOpen,
  requestKey,
  timeoutSeconds,
  deadlineMs,
  timeoutEnabled = true,
  onTimeout,
}: UseDialogCountdownTimeoutOptions): UseDialogCountdownTimeoutReturn {
  const [remainingSeconds, setRemainingSeconds] = useState(timeoutSeconds);
  const deadlineMsRef = useRef(0);
  const submittedRef = useRef(false);
  const timeoutOptionsRef = useRef({ timeoutSeconds, onTimeout });
  useEffect(() => {
    timeoutOptionsRef.current = { timeoutSeconds, onTimeout };
  }, [timeoutSeconds, onTimeout]);

  const triggerTimeout = useCallback(() => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    // A refused bridge write must not deadlock the dialog: re-arm so the next
    // interaction retries the timeout decision (the deadline itself never moves).
    if (timeoutOptionsRef.current.onTimeout() === false) {
      submittedRef.current = false;
    }
  }, []);

  const markSubmitted = useCallback(() => {
    if (submittedRef.current) return false;
    // Background pages may throttle intervals, so submission must check the actual deadline.
    if (Date.now() >= deadlineMsRef.current) {
      triggerTimeout();
      return false;
    }
    submittedRef.current = true;
    return true;
  }, [triggerTimeout]);

  // A refused bridge write may retry, but it never earns a new deadline.
  const restoreSubmission = useCallback(() => {
    if (Date.now() < deadlineMsRef.current) submittedRef.current = false;
  }, []);

  useEffect(() => {
    if (!isOpen || !requestKey) return;

    if (!timeoutEnabled) {
      deadlineMsRef.current = Number.POSITIVE_INFINITY;
      submittedRef.current = false;
      setRemainingSeconds(0);
      return;
    }
    deadlineMsRef.current = typeof deadlineMs === 'number' && Number.isFinite(deadlineMs) && deadlineMs > 0
      ? deadlineMs
      : Date.now() + timeoutOptionsRef.current.timeoutSeconds * 1000;
    submittedRef.current = false;
    const remaining = () => Math.max(0, Math.ceil((deadlineMsRef.current - Date.now()) / 1000));
    const initialRemaining = remaining();
    setRemainingSeconds(initialRemaining);
    if (initialRemaining === 0) {
      triggerTimeout();
      return;
    }

    const timer = setInterval(() => {
      const nextRemaining = remaining();
      setRemainingSeconds(nextRemaining);
      if (nextRemaining === 0) {
        clearInterval(timer);
        triggerTimeout();
      }
    }, 1000);
    return () => clearInterval(timer);
    // Channels may reuse IDs; a new deadline must also start an independent timer lifecycle.
  }, [isOpen, requestKey, deadlineMs, timeoutEnabled, triggerTimeout]);

  return {
    remainingSeconds,
    isTimeWarning: timeoutEnabled && remainingSeconds <= WARNING_THRESHOLD_SECONDS && remainingSeconds > 0,
    isTimedOut: timeoutEnabled && remainingSeconds <= 0,
    markSubmitted,
    restoreSubmission,
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';

const WARNING_THRESHOLD_SECONDS = 30;

interface UseDialogCountdownTimeoutOptions {
  isOpen: boolean;
  requestKey?: string | null;
  timeoutSeconds: number;
  onTimeout: () => void;
}

interface UseDialogCountdownTimeoutReturn {
  remainingSeconds: number;
  isTimeWarning: boolean;
  isTimedOut: boolean;
  markSubmitted: () => boolean;
}

export function useDialogCountdownTimeout({
  isOpen,
  requestKey,
  timeoutSeconds,
  onTimeout,
}: UseDialogCountdownTimeoutOptions): UseDialogCountdownTimeoutReturn {
  const [remainingSeconds, setRemainingSeconds] = useState(timeoutSeconds);
  const remainingSecondsRef = useRef(timeoutSeconds);
  const deadlineMsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const submittedRef = useRef(false);
  const expiredRef = useRef(false);
  const timeoutFiredRef = useRef(false);

  // Capture the latest timeoutSeconds so the open effect can read it without
  // adding timeoutSeconds to its dependency list.
  const capturedTimeoutRef = useRef(timeoutSeconds);
  capturedTimeoutRef.current = timeoutSeconds;

  const triggerTimeout = useCallback(() => {
    expiredRef.current = true;
    if (submittedRef.current || timeoutFiredRef.current) {
      return;
    }
    timeoutFiredRef.current = true;
    submittedRef.current = true;
    onTimeout();
  }, [onTimeout]);

  const markSubmitted = useCallback(() => {
    if (submittedRef.current || expiredRef.current) {
      return false;
    }
    if (Date.now() >= deadlineMsRef.current) {
      // setInterval tick can be deferred by event loop pressure or tab throttling,
      // so the wall-clock deadline is the authoritative gate on user submissions.
      triggerTimeout();
      return false;
    }
    submittedRef.current = true;
    return true;
  }, [triggerTimeout]);

  useEffect(() => {
    if (isOpen && requestKey) {
      const effectiveTimeout = capturedTimeoutRef.current;
      submittedRef.current = false;
      expiredRef.current = false;
      timeoutFiredRef.current = false;
      remainingSecondsRef.current = effectiveTimeout;
      setRemainingSeconds(effectiveTimeout);
      deadlineMsRef.current = Date.now() + effectiveTimeout * 1000;
    }
  }, [isOpen, requestKey]);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    if (!isOpen || !requestKey) {
      clearTimer();
      return;
    }

    clearTimer();
    timerRef.current = setInterval(() => {
      const nextRemainingSeconds = Math.max(
        0,
        Math.ceil((deadlineMsRef.current - Date.now()) / 1000),
      );
      remainingSecondsRef.current = nextRemainingSeconds;
      setRemainingSeconds(nextRemainingSeconds);
      if (nextRemainingSeconds === 0) {
        clearTimer();
        triggerTimeout();
      }
    }, 1000);

    return clearTimer;
  }, [isOpen, requestKey, triggerTimeout]);

  const isTimeWarning = remainingSeconds <= WARNING_THRESHOLD_SECONDS && remainingSeconds > 0;
  const isTimedOut = remainingSeconds <= 0;

  return {
    remainingSeconds,
    isTimeWarning,
    isTimedOut,
    markSubmitted,
  };
}

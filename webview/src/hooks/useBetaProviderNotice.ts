import { useCallback, useMemo, useRef, useState } from 'react';
import {
  hasSeenBetaProviderNotice,
  markBetaProviderNoticeSeen,
} from '../utils/betaProviderNotice';

export interface BetaProviderNoticeState {
  /** Whether the beta notice dialog is open */
  isOpen: boolean;
  /**
   * Call when the user picks a provider that may need a beta notice.
   * If a notice is needed, opens the dialog and runs `onProceed` after the user
   * dismisses it. Otherwise runs `onProceed` immediately.
   */
  requestSelect: (isBeta: boolean, onProceed: () => void) => void;
  /** Close dialog, mark notice seen, then run the pending selection */
  close: () => void;
}

/**
 * Shared first-click Beta notice for Grok / Kimi / OpenCode / PI.
 * Used by ProviderSelect and BlinkingLogo so both entry points behave the same.
 *
 * The dialog is informational only: dismissing it (button, Escape, or overlay)
 * always continues the pending provider selection.
 */
export function useBetaProviderNotice(): BetaProviderNoticeState {
  const [isOpen, setIsOpen] = useState(false);
  // Ref avoids stale closures when acknowledging the dialog after async re-render.
  const pendingProceedRef = useRef<(() => void) | null>(null);

  const requestSelect = useCallback((isBeta: boolean, onProceed: () => void) => {
    if (!isBeta || hasSeenBetaProviderNotice()) {
      onProceed();
      return;
    }
    pendingProceedRef.current = onProceed;
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    markBetaProviderNoticeSeen();
    const proceed = pendingProceedRef.current;
    pendingProceedRef.current = null;
    proceed?.();
  }, []);

  // Memoized so consumers can safely list the return value in
  // useCallback/useMemo deps without re-binding every render.
  return useMemo(() => ({
    isOpen,
    requestSelect,
    close,
  }), [isOpen, requestSelect, close]);
}

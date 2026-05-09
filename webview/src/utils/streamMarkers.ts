// ---------------------------------------------------------------------------
// Helper functions for mergeConsecutiveAssistantMessages
// These functions handle the stream-ended marker cleanup and checking.
// ---------------------------------------------------------------------------

/**
 * Clear stale stream-ended markers from window global state.
 * Called once at the entry of mergeConsecutiveAssistantMessages to avoid
 * modifying global state inside a pure judgment function.
 * The marker expires after 5 seconds to allow normal history merging.
 */
export const clearStaleStreamEndedMarker = (): void => {
  const lastEndedTime = window.__lastStreamEndedAt;
  if (lastEndedTime && Date.now() - lastEndedTime > 5000) {
    window.__lastStreamEndedTurnId = undefined;
    window.__lastStreamEndedAt = undefined;
  }
};

/**
 * Check if a message has the recently-ended streaming turn ID.
 * Used to block merging of recently-ended streaming messages with history messages.
 * Returns true if the message's turnId matches the last ended streaming turn.
 */
export const hasRecentlyEndedTurnId = (turnId: number | undefined): boolean => {
  const lastEndedTurnId = window.__lastStreamEndedTurnId;
  return lastEndedTurnId !== undefined && lastEndedTurnId > 0 && turnId === lastEndedTurnId;
};

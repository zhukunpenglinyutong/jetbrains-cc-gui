package com.github.claudecodegui.provider.common;

/**
 * Indicates that a persisted provider session transcript is still being written.
 *
 * <p>Distinct from {@link SessionHistoryNotFoundException}: the session exists and
 * its transcript is merely mid-append, so the live transcript must be kept and the
 * load retried rather than reported as a failure.</p>
 */
public final class SessionHistoryIncompleteException extends RuntimeException {

    /**
     * Creates an exception for a session whose transcript is incomplete.
     *
     * @param message description of the incomplete state
     */
    public SessionHistoryIncompleteException(String message) {
        super(message);
    }
}

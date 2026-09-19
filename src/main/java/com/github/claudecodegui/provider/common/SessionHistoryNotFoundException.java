package com.github.claudecodegui.provider.common;

/**
 * Indicates that a persisted provider session transcript is no longer available.
 */
public final class SessionHistoryNotFoundException extends RuntimeException {

    /**
     * Creates an exception for a session whose persisted transcript is unavailable.
     *
     * @param sessionId the missing session identifier
     * @param cwd the working directory used for the lookup
     */
    public SessionHistoryNotFoundException(String sessionId, String cwd) {
        super("Session history not found for session " + sessionId + " in " + cwd);
    }
}

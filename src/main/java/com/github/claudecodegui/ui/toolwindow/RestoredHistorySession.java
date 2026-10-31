package com.github.claudecodegui.ui.toolwindow;

/** One-shot restore binding; tab activation cannot reopen a committed restore. */
final class RestoredHistorySession<T> {
    private T session;
    private String sessionId;
    private boolean committed;
    private boolean attempted;

    synchronized void bind(T restoredSession, String restoredSessionId) {
        session = restoredSessionId != null ? restoredSession : null;
        sessionId = restoredSessionId;
        committed = false;
        attempted = false;
    }

    synchronized boolean isCurrent(T currentSession, String currentSessionId) {
        return !committed && currentSession != null && currentSession == session && sessionId != null
                && sessionId.equals(currentSessionId);
    }

    synchronized String sessionId() {
        return sessionId;
    }

    synchronized boolean wasAttempted() {
        return attempted;
    }

    synchronized void markAttempted() {
        attempted = true;
    }

    synchronized void complete(T currentSession, String currentSessionId) {
        if (currentSession == session && sessionId != null && sessionId.equals(currentSessionId)) {
            session = null;
            sessionId = null;
        }
    }

    synchronized void markCommitted(T currentSession, String currentSessionId) {
        if (isCurrent(currentSession, currentSessionId)) {
            committed = true;
        }
    }
}

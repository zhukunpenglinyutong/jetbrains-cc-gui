package com.github.claudecodegui;

/**
 * Session load service (singleton).
 * Used to pass session load requests between the "Session History" and "Claude Code GUI" tool windows.
 */
public class SessionLoadService {

    private static final SessionLoadService INSTANCE = new SessionLoadService();

    private SessionLoadListener listener;
    private String pendingSessionId;
    private String pendingProjectPath;

    private SessionLoadService() {
    }

    public static SessionLoadService getInstance() {
        return INSTANCE;
    }

    /**
     * Listener for session load events.
     */
    public interface SessionLoadListener {
        void onLoadSessionRequest(String sessionId, String projectPath);
    }

    /**
     * Sets the listener (called by the Claude Code GUI window).
     */
    public void setListener(SessionLoadListener listener) {
        this.listener = listener;

        // If there is a pending load request, trigger it immediately
        if (pendingSessionId != null && listener != null) {
            listener.onLoadSessionRequest(pendingSessionId, pendingProjectPath);
            pendingSessionId = null;
            pendingProjectPath = null;
        }
    }

    /**
     * Requests loading a session (called by the "Session History" window).
     */
    public void requestLoadSession(String sessionId, String projectPath) {
        if (listener != null) {
            listener.onLoadSessionRequest(sessionId, projectPath);
        } else {
            // If the listener has not been set yet, save the request as pending
            pendingSessionId = sessionId;
            pendingProjectPath = projectPath;
        }
    }

    /**
     * Clears the listener.
     */
    public void clearListener() {
        this.listener = null;
    }
}

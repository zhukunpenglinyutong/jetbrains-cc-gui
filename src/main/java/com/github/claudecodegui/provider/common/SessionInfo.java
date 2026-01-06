package com.github.claudecodegui.provider.common;

/**
 * Common session information structure.
 * Used by both Claude and Codex history readers.
 */
public class SessionInfo {
    public String sessionId;
    public String title;
    public int messageCount;
    public long lastTimestamp;
    public long firstTimestamp;
    public String cwd; // Working directory path (used by Codex)

    public SessionInfo() {
    }

    public SessionInfo(String sessionId, String title) {
        this.sessionId = sessionId;
        this.title = title;
    }

    @Override
    public String toString() {
        return "SessionInfo{" +
                "sessionId='" + sessionId + '\'' +
                ", title='" + title + '\'' +
                ", messageCount=" + messageCount +
                '}';
    }
}

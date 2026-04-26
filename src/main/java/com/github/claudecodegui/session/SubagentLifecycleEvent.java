package com.github.claudecodegui.session;

public record SubagentLifecycleEvent(
        Kind kind,
        String provider,
        String toolUseId,
        String parentToolUseId,
        String agentHandle,
        String completionToken
) {
    public enum Kind { STARTED, SPAWN_RESOLVED, COMPLETED, CANCELLED }
}

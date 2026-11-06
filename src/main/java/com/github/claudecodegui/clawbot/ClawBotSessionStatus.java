package com.github.claudecodegui.clawbot;

/** Sanitized session lifecycle states exposed by the gateway. */
public enum ClawBotSessionStatus {
    ONLINE,
    BUSY,
    OFFLINE,
    STALE,
    UNAUTHORIZED,
    UNKNOWN
}

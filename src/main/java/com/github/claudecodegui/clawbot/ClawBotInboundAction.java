package com.github.claudecodegui.clawbot;

/** Bounded actions that an external message may request on a registered IDE tab. */
public enum ClawBotInboundAction {
    MESSAGE,
    ANSWER,
    INTERRUPT,
    NEW_SESSION,
    APPROVE,
    DENY,
    UNSUPPORTED_MEDIA
}

package com.github.claudecodegui.handler.diff;

/**
 * Enum representing the user's action on an interactive diff view.
 */
public enum DiffAction {
    /**
     * User accepted the proposed changes.
     */
    APPLY,

    /**
     * User rejected the proposed changes (clicked Reject button).
     */
    REJECT,

    /**
     * User dismissed the diff view without taking action (closed the window).
     * The file remains in its current state (with pending changes).
     */
    DISMISS
}

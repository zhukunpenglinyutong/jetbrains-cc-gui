package com.github.claudecodegui.session;

/**
 * Temporary opencode callback handler.
 *
 * opencode will emit the same normalized bridge markers as Codex in the first
 * bridge slice. Replace this with an opencode-specific handler when the event
 * translator starts emitting opencode tool, permission, and diff details.
 */
public class OpenCodeMessageHandler extends CodexMessageHandler {

    public OpenCodeMessageHandler(SessionState state, CallbackHandler callbackHandler) {
        super(state, callbackHandler);
    }
}

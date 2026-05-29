package com.github.claudecodegui.session;

/**
 * opencode callback handler built on the Codex-normalized bridge contract.
 *
 * OpenCode emits the same STREAM_START/STREAM_END markers as Codex. The webview
 * uses Codex-style minimal stream-end recovery when stream_end arrives without
 * a prior stream_start.
 */
public class OpenCodeMessageHandler extends CodexMessageHandler {

    public OpenCodeMessageHandler(SessionState state, CallbackHandler callbackHandler) {
        super(state, callbackHandler);
    }
}

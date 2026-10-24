package com.github.claudecodegui.provider.common;

/**
 * SDK message callback interface.
 * Used for streaming responses from AI providers (Claude/Codex).
 */
public interface MessageCallback {
    /** Opaque backend turn correlation; unrelated callbacks/providers can leave it unavailable. */
    default String executionScope() {
        return "";
    }

    /**
     * Called when a message is received.
     *
     * @param type    Message type (e.g., "content", "content_delta", "message_start", "message_end")
     * @param content Message content (may be JSON string or plain text)
     */
    void onMessage(String type, String content);

    /**
     * Called when an error occurs.
     *
     * @param error Error message
     */
    void onError(String error);

    /**
     * Called when the operation completes.
     *
     * @param result The final result
     */
    void onComplete(SDKResult result);
}

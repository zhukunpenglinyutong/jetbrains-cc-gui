package com.github.claudecodegui.handler;

/**
 * Message handler interface.
 * Handles messages from the frontend JavaScript layer.
 */
public interface MessageHandler {

    /**
     * Handle a message.
     * @param type the message type
     * @param content the message content
     * @return true if the message was handled, false if not
     */
    boolean handle(String type, String content);

    /**
     * Get the message type prefixes supported by this handler.
     * Used for quickly determining whether this handler should process a message.
     * @return array of supported message type prefixes
     */
    String[] getSupportedTypes();
}

package com.github.claudecodegui.handler.diff;

/**
 * Handles one or more diff-related message types.
 */
public interface DiffActionHandler {

    /**
     * Returns the message types this handler supports.
     */
    String[] getSupportedTypes();

    /**
     * Returns whether this handler supports the given message type.
     */
    default boolean supports(String type) {
        for (String supported : getSupportedTypes()) {
            if (supported.equals(type)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Handles the diff-related message.
     */
    void handle(String type, String content);
}

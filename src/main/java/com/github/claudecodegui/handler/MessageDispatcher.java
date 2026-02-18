package com.github.claudecodegui.handler;

import java.util.ArrayList;
import java.util.List;

/**
 * Message dispatcher.
 * Routes messages to the appropriate handler for processing.
 */
public class MessageDispatcher {

    private final List<MessageHandler> handlers = new ArrayList<>();

    /**
     * Register a message handler.
     */
    public void registerHandler(MessageHandler handler) {
        handlers.add(handler);
    }

    /**
     * Dispatch a message to the appropriate handler.
     * @param type the message type
     * @param content the message content
     * @return true if the message was handled, false if no handler could process it
     */
    public boolean dispatch(String type, String content) {
        for (MessageHandler handler : handlers) {
            if (handler.handle(type, content)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check whether any handler supports the given message type.
     */
    public boolean hasHandlerFor(String type) {
        for (MessageHandler handler : handlers) {
            for (String supported : handler.getSupportedTypes()) {
                if (supported.equals(type)) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Get the number of registered handlers.
     */
    public int getHandlerCount() {
        return handlers.size();
    }

    /**
     * Clear all registered handlers.
     */
    public void clear() {
        handlers.clear();
    }
}

package com.github.claudecodegui.handler.diff;

import java.util.ArrayList;
import java.util.List;

/**
 * Routes diff-related messages to the first supporting handler.
 */
public class DiffRequestDispatcher {

    private final List<DiffActionHandler> handlers;

    public DiffRequestDispatcher(List<DiffActionHandler> handlers) {
        this.handlers = List.copyOf(handlers);
    }

    public boolean dispatch(String type, String content) {
        for (DiffActionHandler handler : handlers) {
            if (handler.supports(type)) {
                handler.handle(type, content);
                return true;
            }
        }
        return false;
    }

    /**
     * Collects all supported types from registered handlers.
     */
    public String[] getAllSupportedTypes() {
        List<String> types = new ArrayList<>();
        for (DiffActionHandler handler : handlers) {
            for (String type : handler.getSupportedTypes()) {
                types.add(type);
            }
        }
        return types.toArray(new String[0]);
    }
}

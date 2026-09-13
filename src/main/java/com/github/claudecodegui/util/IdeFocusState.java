package com.github.claudecodegui.util;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.awt.KeyboardFocusManager;
import java.awt.Window;
import java.util.concurrent.atomic.AtomicBoolean;

final class IdeFocusState {

    private static final Logger LOG = Logger.getInstance(IdeFocusState.class);

    private IdeFocusState() {
    }

    static boolean isIdeApplicationFocused() {
        if (ApplicationManager.getApplication().isDispatchThread()) {
            return computeIdeApplicationFocused();
        }

        AtomicBoolean focused = new AtomicBoolean(false);
        try {
            ApplicationManager.getApplication().invokeAndWait(
                    () -> focused.set(computeIdeApplicationFocused())
            );
        } catch (Exception e) {
            LOG.debug("[IdeFocusState] Failed to read IDE application focus on EDT: " + e.getMessage());
        }
        return focused.get();
    }

    private static boolean computeIdeApplicationFocused() {
        Window focusedWindow = KeyboardFocusManager.getCurrentKeyboardFocusManager().getFocusedWindow();
        return focusedWindow != null && focusedWindow.isFocused();
    }
}

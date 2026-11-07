package com.github.claudecodegui.ui.toolwindow;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowAnchor;
import com.intellij.openapi.wm.ToolWindowManager;

/** Restores the launcher without creating browser content or activating the chat. */
final class ToolWindowStripeSupport {
    private static final Logger LOG = Logger.getInstance(ToolWindowStripeSupport.class);

    private ToolWindowStripeSupport() {
    }

    // Run after registration so a saved per-project layout cannot hide or move the launcher.
    static void pinToRight(ToolWindowManager manager, ToolWindow toolWindow) {
        if (toolWindow.isDisposed() || toolWindow.getProject().isDisposed()) {
            return;
        }
        if (toolWindow.getAnchor() != ToolWindowAnchor.RIGHT) {
            toolWindow.setAnchor(ToolWindowAnchor.RIGHT, null);
        }
        // Reapplying an unchanged layout can disturb a live native browser on the client.
        if (toolWindow.isShowStripeButton()) {
            return;
        }
        toolWindow.setShowStripeButton(true);

        // New UI ignores setShowStripeButton after init. Its dedicated operation also
        // publishes the layout event when the backend already believes the button is pinned.
        // Resolve it optionally to keep classic UI and older IDE builds compatible.
        try {
            manager.getClass().getMethod("setVisibleOnLargeStripe", String.class, boolean.class)
                    .invoke(manager, toolWindow.getId(), true);
        } catch (NoSuchMethodException ignored) {
            // Classic UI uses the public ToolWindow setter above.
        } catch (ReflectiveOperationException | RuntimeException e) {
            LOG.warn("[ToolWindow] Could not restore the new UI stripe button", e);
        }
    }
}

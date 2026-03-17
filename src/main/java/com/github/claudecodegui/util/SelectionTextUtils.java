package com.github.claudecodegui.util;

import com.github.claudecodegui.ClaudeCodeGuiBundle;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.util.concurrency.AppExecutorUtil;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.concurrent.TimeUnit;

/**
 * Utility class for handling text selection and sending it to the CCG input box.
 */
public final class SelectionTextUtils {

    private static final Logger LOG = Logger.getInstance(SelectionTextUtils.class);
    private static final int ACTIVATION_DELAY_MS = 300;

    private SelectionTextUtils() {
    }

    /**
     * Normalizes externally selected text before sending it to the chat input.
     *
     * @param text the text to normalize, may be null
     * @return the normalized text, or null if the text is null or blank
     */
    public static @Nullable String normalizeSendableText(@Nullable String text) {
        if (text == null) {
            return null;
        }
        if (text.trim().isEmpty()) {
            return null;
        }
        return text;
    }

    /**
     * Sends selected text to the CCG tool window input box.
     * Handles the case where the tool window needs to be activated first.
     *
     * @param project      the current project
     * @param selectedText the text to send
     * @param sourceName   the source name for logging (e.g., "console", "terminal")
     */
    public static void sendToChatWindow(@NotNull Project project,
                                        @Nullable String selectedText,
                                        @Nullable String sourceName) {
        String normalizedText = normalizeSendableText(selectedText);
        if (normalizedText == null) {
            LOG.warn("Skip sending empty external selection");
            return;
        }

        String resolvedSourceName = normalizeSourceName(sourceName);
        try {
            if (project.isDisposed()) {
                LOG.warn("Project disposed, cannot inject " + resolvedSourceName + " selection");
                return;
            }

            ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
            if (toolWindow == null) {
                String message = ClaudeCodeGuiBundle.message("send.toolWindowNotFound");
                LOG.error(message);
                notifySendFailure(project, message);
                return;
            }

            if (!toolWindow.isVisible()) {
                toolWindow.activate(() -> AppExecutorUtil.getAppScheduledExecutorService().schedule(() ->
                        ApplicationManager.getApplication().invokeLater(() -> {
                            try {
                                if (project.isDisposed()) {
                                    LOG.warn("Project disposed before selection injection: " + resolvedSourceName);
                                    return;
                                }
                                injectSelection(project, normalizedText, resolvedSourceName, true);
                            } catch (Exception ex) {
                                handleSendFailure(project, resolvedSourceName, ex, true);
                            }
                        }), ACTIVATION_DELAY_MS, TimeUnit.MILLISECONDS), true);
                return;
            }

            injectSelection(project, normalizedText, resolvedSourceName, false);
            toolWindow.activate(null, true);
        } catch (Exception ex) {
            handleSendFailure(project, resolvedSourceName, ex, false);
        }
    }

    private static void injectSelection(@NotNull Project project,
                                        @NotNull String selectedText,
                                        @NotNull String sourceName,
                                        boolean afterActivation) {
        com.github.claudecodegui.ClaudeSDKToolWindow.addSelectionFromExternal(project, selectedText);
        if (afterActivation) {
            LOG.info("Injected " + sourceName + " selection after activating CCG: " + project.getName());
        } else {
            LOG.info("Injected " + sourceName + " selection into active CCG tab: " + project.getName());
        }
    }

    private static @NotNull String normalizeSourceName(@Nullable String sourceName) {
        if (sourceName == null || sourceName.trim().isEmpty()) {
            return "external";
        }
        return sourceName;
    }

    private static void handleSendFailure(@NotNull Project project,
                                          @NotNull String sourceName,
                                          @NotNull Exception ex,
                                          boolean afterActivation) {
        String message = ClaudeCodeGuiBundle.message("send.sendToChatFailed", ex.getMessage());
        if (afterActivation) {
            LOG.error("Failed to inject " + sourceName + " selection after activation", ex);
        } else {
            LOG.error("Failed to send " + sourceName + " selection to CCG", ex);
        }
        notifySendFailure(project, message);
    }

    private static void notifySendFailure(@NotNull Project project, @NotNull String message) {
        if (!project.isDisposed()) {
            ClaudeNotifier.showError(project, message);
        }
    }
}

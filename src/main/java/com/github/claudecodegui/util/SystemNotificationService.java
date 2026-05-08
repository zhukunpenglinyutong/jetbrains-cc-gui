package com.github.claudecodegui.util;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.notification.Notification;
import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * System notification service.
 * Provides IDE native notifications for task completion.
 *
 * @author melon
 * @email "mailto:melon@email.com"
 * @date 2026-05-08 17:07
 * @version 1.0.0
 * @since 1.0.0
 */
public class SystemNotificationService {

    /**
     * log.
     */
    private static final Logger LOG = Logger.getInstance(SystemNotificationService.class);

    /**
     * max message length.
     */
    private static final int MAX_MESSAGE_LENGTH = 220;
    /**
     * max title length.
     */ // Tightened so titles fit on a single 14pt-bold line in WINDOW_WIDTH for both
    // CJK and Latin scripts, avoiding HTML JLabel height-measurement issues
    // that can clip wrapped titles inside BoxLayout.
    private static final int MAX_TITLE_LENGTH = 35;
    /**
     * message ellipsis tail.
     */
    private static final int MESSAGE_ELLIPSIS_TAIL = 3;
    /**
     * instance.
     */
    private static volatile SystemNotificationService instance;

    /**
     * System Notification Service
     *
     * @since 1.0.0
     */
    private SystemNotificationService() {
    }

    /**
     * Get Instance
     *
     * @return system notification service
     * @since 1.0.0
     */
    public static SystemNotificationService getInstance() {
        if (instance == null) {
            synchronized (SystemNotificationService.class) {
                if (instance == null) {
                    instance = new SystemNotificationService();
                }
            }
        }
        return instance;
    }

    /**
     * Show visual notification window with a fallback title.
     *
     * @param project project
     * @param message message
     * @since 1.0.0
     */
    public void showVisualNotificationToast(@NotNull Project project, String message) {
        showVisualNotificationToast(project, null, message);
    }

    /**
     * Show visual notification window with an explicit dynamic title.
     * When {@code title} is null/blank, the i18n default
     * {@code notifier.taskComplete.title} is used.
     *
     * @param project project
     * @param title title
     * @param message message
     * @since 1.0.0
     */
    public void showVisualNotificationToast(@NotNull Project project, @Nullable String title, String message) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }
            try {
                if (!isEnabled()) {
                    return;
                }
                String resolvedTitle = sanitizeTitle(title);
                String resolvedMessage = sanitizeMessage(message);

                showIdeNativeNotification(project, resolvedTitle, resolvedMessage);
            } catch (Exception e) {
                LOG.warn("[SystemNotification] Failed to show visual notification: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Is Enabled
     *
     * @return boolean
     * @since 1.0.0
     */
    private boolean isEnabled() {
        try {
            return new CodemossSettingsService().getTaskCompletionNotificationEnabled();
        } catch (Exception e) {
            LOG.debug("[SystemNotification] Failed to read enabled flag, defaulting to false: " + e.getMessage());
            return false;
        }
    }

    /**
     * Truncate by code points (so emoji and surrogate pairs stay intact) and HTML-escape
     * the result before embedding into a {@code <html>...</html>} JLabel.
     *
     * @param raw raw
     * @return string
     * @since 1.0.0
     */
    private String sanitizeMessage(String raw) {
        return truncateAndEscape(raw == null ? "" : raw, MAX_MESSAGE_LENGTH);
    }

    /**
     * Resolve the toast title: use the caller-provided title when non-blank,
     * otherwise fall back to the i18n default. The returned string is HTML-escaped
     * and truncated for safe embedding in a JLabel.
     *
     * @param raw raw
     * @return string
     * @since 1.0.0
     */
    private String sanitizeTitle(@Nullable String raw) {
        String chosen = (raw == null || raw.trim().isEmpty())
            ? ClaudeCodeGuiBundle.message("notifier.taskComplete.title")
            : raw.trim();
        return truncateAndEscape(chosen, MAX_TITLE_LENGTH);
    }

    /**
     * Truncate And Escape
     *
     * @param text text
     * @param maxLength max length
     * @return string
     * @since 1.0.0
     */
    private String truncateAndEscape(String text, int maxLength) {
        int cpCount = text.codePointCount(0, text.length());
        if (cpCount > maxLength) {
            int end = text.offsetByCodePoints(0, maxLength - MESSAGE_ELLIPSIS_TAIL);
            text = text.substring(0, end) + "...";
        }
        return escapeHtml(text);
    }

    /**
     * Escape Html
     *
     * @param input input
     * @return string
     * @since 1.0.0
     */
    private static String escapeHtml(String input) {
        StringBuilder sb = new StringBuilder(input.length() + 16);
        for (int i = 0; i < input.length(); i++) {
            char c = input.charAt(i);
            switch (c) {
                case '&':
                    sb.append("&amp;");
                    break;
                case '<':
                    sb.append("&lt;");
                    break;
                case '>':
                    sb.append("&gt;");
                    break;
                case '"':
                    sb.append("&quot;");
                    break;
                case '\'':
                    sb.append("&#39;");
                    break;
                default:
                    sb.append(c);
            }
        }
        return sb.toString();
    }

    /**
     * Show Ide Native Notification
     *
     * @param project project
     * @param escapedTitle escaped title
     * @param escapedMessage escaped message
     * @since 1.0.0
     */
    private void showIdeNativeNotification(@NotNull Project project, String escapedTitle, String escapedMessage) {
        Notification notification = NotificationGroupManager.getInstance()
            .getNotificationGroup("CC GUI Notifications")
            .createNotification(unescapeHtml(escapedTitle), unescapeHtml(escapedMessage), NotificationType.INFORMATION);
        notification.notify(project);
    }

    /**
     * Unescape Html
     *
     * @param input input
     * @return string
     * @since 1.0.0
     */
    private static String unescapeHtml(String input) {
        return input
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&amp;", "&");
    }
}

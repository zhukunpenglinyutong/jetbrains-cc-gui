package com.github.claudecodegui.notifications;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.util.SoundNotificationService;
import com.github.claudecodegui.util.SystemNotificationService;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import java.util.ConcurrentModificationException;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.List;
import java.util.regex.Pattern;

/**
 * Simple utility to update the Claude Status Bar Widget and show notifications.
 *
 * @author melon
 * @email "mailto:melon@email.com"
 * @date 2026-05-08 09:48
 * @version 1.0.0
 * @since 1.0.0
 */
public class ClaudeNotifier {

    /**
     * code fence open.
     */ // Pre-compiled patterns for {@link #condenseForToast}, reused across notifications.
    private static final Pattern CODE_FENCE_OPEN = Pattern.compile("```[a-zA-Z0-9_+\\-]*\\n");
    /**
     * code fence close.
     */
    private static final Pattern CODE_FENCE_CLOSE = Pattern.compile("```");
    /**
     * whitespace run.
     */
    private static final Pattern WHITESPACE_RUN = Pattern.compile("\\s+");

    /**
     * condense max input.
     */ // Cap how much of an assistant message we run regex over. The toast itself only
    // shows ~220 codepoints; processing the whole message (which can be tens of KB)
    // is wasteful and never adds visible content.
    private static final int CONDENSE_MAX_INPUT = 4096;

    /**
     * Set Thinking
     *
     * @param project project
     * @since 1.0.0
     */
    public static void setThinking(@NotNull Project project) {
        update(project, "thinking", ClaudeCodeGuiBundle.message("notifier.thinking"));
    }

    /**
     * Set Generating
     *
     * @param project project
     * @since 1.0.0
     */
    public static void setGenerating(@NotNull Project project) {
        update(project, "generating", ClaudeCodeGuiBundle.message("notifier.generating"));
    }

    /**
     * Set Waiting
     *
     * @param project project
     * @since 1.0.0
     */
    public static void setWaiting(@NotNull Project project) {
        update(project, "waiting", ClaudeCodeGuiBundle.message("notifier.waiting"));
    }

    /**
     * Show Success
     *
     * @param project project
     * @param message message
     * @since 1.0.0
     */
    public static void showSuccess(@NotNull Project project, String message) {
        showSuccess(project, null, message);
    }

    /**
     * Show a generic success hint in the status bar widget only.
     *
     * @param project project
     * @param title title
     * @param message message
     * @since 1.0.0
     */
    public static void showSuccess(@NotNull Project project, @Nullable String title, String message) {
        show(project, "Claude ✓", message, 5000);
    }

    /**
     * Show task completion notification with an optional dynamic title.
     * When {@code title} is null/blank, the toast falls back to the i18n
     * default ({@code notifier.taskComplete.title}).
     *
     * @param project project
     * @param title title
     * @param message message
     * @since 1.0.0
     */
    public static void showTaskCompletionSuccess(@NotNull Project project, @Nullable String title, String message) {
        show(project, "Claude [OK]", message, 5000);
        // Show the task completion visual notification toast
        SystemNotificationService.getInstance().showVisualNotificationToast(project, title, message);
        // Play the task completion notification sound
        SoundNotificationService.getInstance().playTaskCompleteSound();
    }

    /**
     * Build the toast title from a session: prefer the session summary
     * (the AI-generated session title shown in the UI), otherwise return null
     * so the toast falls back to the i18n default.
     *
     * @param session session
     * @return string
     * @since 1.0.0
     */
    @Nullable
    public static String buildTitleFromSession(@Nullable ClaudeSession session) {
        if (session == null) {
            return null;
        }
        String summary = session.getSummary();
        if (summary == null) {
            return null;
        }
        String trimmed = summary.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /**
     * Build a short preview from the most recent assistant message in the session.
     * Returns {@code fallback} when no assistant content is available.
     * <p>
     * {@code session.getMessages()} returns a defensive copy, but the underlying
     * {@code ArrayList} is not synchronized. If the message list is mutated on a
     * different thread during the copy, the resulting {@link ConcurrentModificationException}
     * (or any other read failure) causes us to fall back gracefully rather than
     * propagate the error into the completion callback.
     *
     * @param session session
     * @param fallback fallback
     * @return string
     * @since 1.0.0
     */
    public static String buildPreviewFromSession(@Nullable ClaudeSession session, String fallback) {
        if (session == null) {
            return fallback;
        }
        try {
            List<ClaudeSession.Message> messages = session.getMessages();
            if (messages == null || messages.isEmpty()) {
                return fallback;
            }
            for (int i = messages.size() - 1; i >= 0; i--) {
                ClaudeSession.Message m = messages.get(i);
                if (m == null || m.type != ClaudeSession.Message.Type.ASSISTANT) {
                    continue;
                }
                // Prefer the last text block from raw JSON: in tool-use turns the
                // accumulated m.content concatenates ALL text segments (including
                // pre-tool-call prose), so the preview would show mid-turn text
                // instead of the final answer.
                String content = extractLastTextFromRaw(m);
                if (content == null || content.isEmpty()) {
                    content = m.content;
                }
                if (content == null || content.isEmpty()) {
                    // Tool-call frames are emitted as ASSISTANT with empty text content;
                    // skip them so the preview prefers actual assistant prose.
                    continue;
                }
                String preview = condenseForToast(content);
                if (!preview.isEmpty()) {
                    return preview;
                }
            }
        } catch (Exception e) {
            // Any failure (CME, IOOBE, etc.) just means we don't have a preview.
            return fallback;
        }
        return fallback;
    }

    /**
     * Collapse multi-line and code-fenced content into a single dense line that
     * reads well inside a toast. The {@link SystemNotificationService} performs
     * the final length truncation, so we only normalize whitespace here.
     * Caps input size to {@link #CONDENSE_MAX_INPUT} so multi-KB assistant
     * responses don't run regex over their entire body.
     *
     * @param raw raw
     * @return string
     * @since 1.0.0
     */
    private static String condenseForToast(String raw) {
        String input = raw.length() > CONDENSE_MAX_INPUT ? raw.substring(0, CONDENSE_MAX_INPUT) : raw;
        // Drop common code fences so toasts don't open with "```java".
        String stripped = CODE_FENCE_OPEN.matcher(input).replaceAll("");
        stripped = CODE_FENCE_CLOSE.matcher(stripped).replaceAll("");
        // Normalize all whitespace runs (including newlines) to single spaces.
        return WHITESPACE_RUN.matcher(stripped).replaceAll(" ").trim();
    }

    /**
     * Show Error
     *
     * @param project project
     * @param message message
     * @since 1.0.0
     */
     * Extract the text of the <b>last</b> text block from the raw JSON of an assistant message.
     * In tool-use turns the raw content array contains multiple text blocks
     * (pre-tool-call prose + final answer); this method returns only the final one.
     *
     * @return the last text block's content, or {@code null} if unavailable.
     */
    @Nullable
    private static String extractLastTextFromRaw(@NotNull ClaudeSession.Message m) {
        JsonObject raw = m.raw;
        if (raw == null || !raw.has("message") || !raw.get("message").isJsonObject()) {
            return null;
        }
        try {
            JsonObject message = raw.getAsJsonObject("message");
            if (!message.has("content") || !message.get("content").isJsonArray()) {
                return null;
            }
            JsonArray contentArray = message.getAsJsonArray("content");
            String lastText = null;
            for (JsonElement element : contentArray) {
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject block = element.getAsJsonObject();
                if (block.has("type") && "text".equals(block.get("type").getAsString())
                        && block.has("text")) {
                    lastText = block.get("text").getAsString();
                }
            }
            return lastText;
        } catch (Exception e) {
            return null;
        }
    }

    public static void showError(@NotNull Project project, String message) {
        show(project, "Claude [ERR]", message, 8000);
    }

    /**
     * Show Warning
     *
     * @param project project
     * @param message message
     * @since 1.0.0
     */
    public static void showWarning(@NotNull Project project, String message) {
        show(project, "Claude [WARN]", message, 6000);
    }

    /**
     * Clear Status
     *
     * @param project project
     * @since 1.0.0
     */
    public static void clearStatus(@NotNull Project project) {
        update(project, "ready", null);
    }
    
    /**
     * Set Token Usage
     *
     * @param project project
     * @param usedTokens used tokens
     * @param maxTokens max tokens
     * @since 1.0.0
     */
    public static void setTokenUsage(@NotNull Project project, int usedTokens, int maxTokens) {
        String tokenInfo = formatTokenUsage(usedTokens, maxTokens);
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) {
                widget.setTokenInfo(tokenInfo);
            }
        });
    }

    /**
     * Format Token Usage
     *
     * @param used used
     * @param max max
     * @return string
     * @since 1.0.0
     */
    private static String formatTokenUsage(int used, int max) {
        if (used == 0) { return ""; }
        String usedStr = formatNumber(used);
        if (max > 0) {
            String maxStr = formatNumber(max);
            return String.format("[%s / %s ctx]", usedStr, maxStr);
        }
        return String.format("[%s ctx]", usedStr);
    }
    
    /**
     * Set Model
     *
     * @param project project
     * @param model model
     * @since 1.0.0
     */
    public static void setModel(@NotNull Project project, String model) {
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) { widget.setModel(model); }
        });
    }

    /**
     * Set Mode
     *
     * @param project project
     * @param mode mode
     * @since 1.0.0
     */
    public static void setMode(@NotNull Project project, String mode) {
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) { widget.setMode(mode); }
        });
    }

    /**
     * Set Agent
     *
     * @param project project
     * @param agent agent
     * @since 1.0.0
     */
    public static void setAgent(@NotNull Project project, String agent) {
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) { widget.setAgent(agent); }
        });
    }

    /**
     * Format Number
     *
     * @param num num
     * @return string
     * @since 1.0.0
     */
    private static String formatNumber(int num) {
        if (num < 1000) { return String.valueOf(num); }
        if (num < 1000000) { return String.format("%.1fk", num / 1000.0); }
        return String.format("%.1fm", num / 1000000.0);
    }

    /**
     * Update
     *
     * @param project project
     * @param status status
     * @param details details
     * @since 1.0.0
     */
    private static void update(@NotNull Project project, String status, String details) {
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) {
                widget.updateStatus(status, details);
            }
        });
    }

    /**
     * Show
     *
     * @param project project
     * @param text text
     * @param tooltip tooltip
     * @param duration duration
     * @since 1.0.0
     */
    private static void show(@NotNull Project project, String text, String tooltip, long duration) {
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) {
                widget.show(text, tooltip, duration);
            }
        });
    }
}

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
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.List;
import java.util.regex.Pattern;

/**
 * Simple utility to update the Claude Status Bar Widget and show notifications.
 */
public class ClaudeNotifier {

    // Pre-compiled patterns for {@link #condenseForToast}, reused across notifications.
    private static final Pattern CODE_FENCE_OPEN = Pattern.compile("```[a-zA-Z0-9_+\\-]*\\n");
    private static final Pattern CODE_FENCE_CLOSE = Pattern.compile("```");
    private static final Pattern WHITESPACE_RUN = Pattern.compile("\\s+");

    // Cap how much of an assistant message we run regex over. The toast itself only
    // shows ~220 codepoints; processing the whole message (which can be tens of KB)
    // is wasteful and never adds visible content.
    private static final int CONDENSE_MAX_INPUT = 4096;

    public static void setThinking(@NotNull Project project) {
        update(project, "thinking", ClaudeCodeGuiBundle.message("notifier.thinking"));
    }

    public static void setGenerating(@NotNull Project project) {
        update(project, "generating", ClaudeCodeGuiBundle.message("notifier.generating"));
    }

    public static void setWaiting(@NotNull Project project) {
        update(project, "waiting", ClaudeCodeGuiBundle.message("notifier.waiting"));
    }

    public static void showSuccess(@NotNull Project project, String message) {
        showSuccess(project, null, message);
    }

    /**
     * Show task completion notification with an optional dynamic title.
     * When {@code title} is null/blank, the toast falls back to the i18n
     * default ({@code notifier.taskComplete.title}).
     */
    public static void showSuccess(@NotNull Project project, @Nullable String title, String message) {
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

    public static void showWarning(@NotNull Project project, String message) {
        show(project, "Claude [WARN]", message, 6000);
    }

    public static void clearStatus(@NotNull Project project) {
        update(project, "ready", null);
    }
    
    public static void setTokenUsage(@NotNull Project project, int usedTokens, int maxTokens) {
        String tokenInfo = formatTokenUsage(usedTokens, maxTokens);
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) {
                widget.setTokenInfo(tokenInfo);
            }
        });
    }

    private static String formatTokenUsage(int used, int max) {
        if (used == 0) { return ""; }
        String usedStr = formatNumber(used);
        if (max > 0) {
            String maxStr = formatNumber(max);
            return String.format("[%s / %s ctx]", usedStr, maxStr);
        }
        return String.format("[%s ctx]", usedStr);
    }
    
    public static void setModel(@NotNull Project project, String model) {
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) { widget.setModel(model); }
        });
    }

    public static void setMode(@NotNull Project project, String mode) {
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) { widget.setMode(mode); }
        });
    }

    public static void setAgent(@NotNull Project project, String agent) {
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) { widget.setAgent(agent); }
        });
    }

    private static String formatNumber(int num) {
        if (num < 1000) { return String.valueOf(num); }
        if (num < 1000000) { return String.format("%.1fk", num / 1000.0); }
        return String.format("%.1fm", num / 1000000.0);
    }

    private static void update(@NotNull Project project, String status, String details) {
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) {
                widget.updateStatus(status, details);
            }
        });
    }

    private static void show(@NotNull Project project, String text, String tooltip, long duration) {
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) {
                widget.show(text, tooltip, duration);
            }
        });
    }
}

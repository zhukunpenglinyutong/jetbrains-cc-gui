package com.github.claudecodegui.util;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.util.concurrency.AppExecutorUtil;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

public final class SelectionTextUtils {

    private static final Logger LOG = Logger.getInstance(SelectionTextUtils.class);
    private static final long ACTIVATION_DELAY_MS = 300L;
    private static final Pattern WALL_TIME_LINE = Pattern.compile("^Wall time:\\s+.+$");
    private static final Pattern EXIT_CODE_LINE = Pattern.compile("^Exit code:\\s+.+$");
    private static final Pattern OUTPUT_HEADER_LINE = Pattern.compile("^Output:\\s*$");
    private static final Pattern POWERSHELL_ERROR_LINE = Pattern.compile(
            "^(?:"
                    + "Check the spelling of the name, or if a path was included, verify that the path is correct and try again\\."
                    + "|Cannot load PSReadline module\\..*$"
                    + "|At line:\\d+ char:\\d+.*$"
                    + "|\\+ CategoryInfo\\s*:.*$"
                    + "|\\+ FullyQualifiedErrorId\\s*:.*$"
                    + "|\\+ ~+$"
                    + ")"
    );

    private static final ToolWindowProvider DEFAULT_TOOL_WINDOW_PROVIDER = SelectionTextUtils::createDefaultToolWindowProvider;
    private static final Scheduler DEFAULT_SCHEDULER = SelectionTextUtils::defaultScheduler;
    private static final ChatInputSender DEFAULT_CHAT_INPUT_SENDER = ClaudeSDKToolWindow::addSelectionFromExternal;
    private static final ErrorNotifier DEFAULT_ERROR_NOTIFIER = SelectionTextUtils::notifyError;

    private static ToolWindowProvider toolWindowProvider = DEFAULT_TOOL_WINDOW_PROVIDER;
    private static Scheduler scheduler = DEFAULT_SCHEDULER;
    private static ChatInputSender chatInputSender = DEFAULT_CHAT_INPUT_SENDER;
    private static ErrorNotifier errorNotifier = DEFAULT_ERROR_NOTIFIER;

    private SelectionTextUtils() {
    }

    interface ToolWindowProvider {
        @Nullable
        ToolWindowProxy get(@Nullable Project project);
    }

    interface ToolWindowProxy {
        boolean isVisible();

        void activate(@NotNull Runnable runnable, boolean autoFocus);
    }

    interface Scheduler {
        void schedule(@NotNull Runnable runnable, long delayMs);
    }

    interface ChatInputSender {
        void send(@NotNull Project project, @NotNull String text);
    }

    interface ErrorNotifier {
        void notify(@Nullable Project project, @NotNull String message);
    }

    public static @Nullable String normalizeSendableText(@Nullable String text) {
        if (text == null) {
            return null;
        }
        String sanitized = stripTerminalNoise(text);
        if (sanitized.trim().isEmpty()) {
            return null;
        }
        return sanitized;
    }

    private static String stripTerminalNoise(@NotNull String text) {
        String normalized = text.replace("\r\n", "\n");
        String[] lines = normalized.split("\n", -1);
        List<String> kept = new ArrayList<>();

        for (String line : lines) {
            if (shouldDropTerminalNoiseLine(line)) {
                continue;
            }
            kept.add(line);
        }

        int start = 0;
        int end = kept.size();
        while (start < end && kept.get(start).trim().isEmpty()) {
            start++;
        }
        while (end > start && kept.get(end - 1).trim().isEmpty()) {
            end--;
        }

        return String.join("\n", kept.subList(start, end));
    }

    private static boolean shouldDropTerminalNoiseLine(@NotNull String line) {
        String trimmed = line.trim();
        if (trimmed.isEmpty()) {
            return false;
        }
        return WALL_TIME_LINE.matcher(trimmed).matches()
                || EXIT_CODE_LINE.matcher(trimmed).matches()
                || OUTPUT_HEADER_LINE.matcher(trimmed).matches()
                || POWERSHELL_ERROR_LINE.matcher(trimmed).matches();
    }

    public static void sendToChatWindow(@NotNull Project project, @NotNull String text) {
        try {
            ToolWindowProxy proxy = toolWindowProvider.get(project);
            if (proxy == null) {
                errorNotifier.notify(project, ClaudeCodeGuiBundle.message("send.toolWindowNotFound"));
                return;
            }
            if (!proxy.isVisible()) {
                proxy.activate(() -> scheduleSend(project, text), true);
            } else {
                sendText(project, text);
            }
        } catch (Exception ex) {
            LOG.error("Failed to send text to chat window", ex);
            errorNotifier.notify(project, ClaudeCodeGuiBundle.message("send.sendToChatFailed", safeMessage(ex)));
        }
    }

    private static void scheduleSend(@NotNull Project project, @NotNull String text) {
        try {
            scheduler.schedule(() -> sendText(project, text), ACTIVATION_DELAY_MS);
        } catch (Exception ex) {
            LOG.error("Failed to schedule chat send", ex);
            errorNotifier.notify(project, ClaudeCodeGuiBundle.message("send.sendToChatFailed", safeMessage(ex)));
        }
    }

    private static void sendText(@NotNull Project project, @NotNull String text) {
        try {
            if (project.isDisposed()) {
                return;
            }
            chatInputSender.send(project, text);
        } catch (Exception ex) {
            LOG.error("Failed to deliver text to chat window", ex);
            errorNotifier.notify(project, ClaudeCodeGuiBundle.message("send.sendToChatFailed", safeMessage(ex)));
        }
    }

    private static void notifyError(@Nullable Project project, @NotNull String message) {
        LOG.error(message);
        if (project == null || project.isDisposed()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }
            Messages.showErrorDialog(project, message, ClaudeCodeGuiBundle.message("dialog.error.title"));
        });
    }

    private static String safeMessage(@Nullable Throwable throwable) {
        if (throwable == null) {
            return "";
        }
        String message = throwable.getMessage();
        return message == null ? "" : message;
    }

    private static ToolWindowProxy createDefaultToolWindowProxy(@NotNull ToolWindow toolWindow) {
        return new ToolWindowProxy() {
            @Override
            public boolean isVisible() {
                return toolWindow.isVisible();
            }

            @Override
            public void activate(@NotNull Runnable runnable, boolean autoFocus) {
                toolWindow.activate(runnable, autoFocus);
            }
        };
    }

    private static ToolWindowProxy createDefaultToolWindowProvider(@Nullable Project project) {
        if (project == null) {
            return null;
        }
        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
        if (toolWindow == null) {
            return null;
        }
        return createDefaultToolWindowProxy(toolWindow);
    }

    private static void defaultScheduler(@NotNull Runnable runnable, long delayMs) {
        AppExecutorUtil.getAppScheduledExecutorService().schedule(() -> ApplicationManager.getApplication().invokeLater(runnable), delayMs, TimeUnit.MILLISECONDS);
    }

    static void setToolWindowProvider(@NotNull ToolWindowProvider provider) {
        toolWindowProvider = provider;
    }

    static void setScheduler(@NotNull Scheduler delayScheduler) {
        scheduler = delayScheduler;
    }

    static void setChatInputSender(@NotNull ChatInputSender sender) {
        chatInputSender = sender;
    }

    static void setErrorNotifier(@NotNull ErrorNotifier notifier) {
        errorNotifier = notifier;
    }

    static void resetTestHooks() {
        toolWindowProvider = DEFAULT_TOOL_WINDOW_PROVIDER;
        scheduler = DEFAULT_SCHEDULER;
        chatInputSender = DEFAULT_CHAT_INPUT_SENDER;
        errorNotifier = DEFAULT_ERROR_NOTIFIER;
    }
}

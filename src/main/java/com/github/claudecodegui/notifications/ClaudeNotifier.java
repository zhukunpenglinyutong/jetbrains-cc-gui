package com.github.claudecodegui.notifications;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;

/**
 * Simple utility to update the Claude Status Bar Widget.
 */
public class ClaudeNotifier {

    public static void setThinking(@NotNull Project project) {
        update(project, "thinking", "Claude is thinking...");
    }

    public static void setGenerating(@NotNull Project project) {
        update(project, "generating", "Claude is generating response...");
    }

    public static void setWaiting(@NotNull Project project) {
        update(project, "waiting", "Waiting for Claude...");
    }

    public static void showSuccess(@NotNull Project project, String message) {
        show(project, "Claude ✓", message, 5000);
    }

    public static void showError(@NotNull Project project, String message) {
        show(project, "Claude ✗", message, 8000);
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
        if (used == 0) return "";
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
            if (widget != null) widget.setModel(model);
        });
    }

    public static void setMode(@NotNull Project project, String mode) {
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) widget.setMode(mode);
        });
    }

    public static void setAgent(@NotNull Project project, String agent) {
        ApplicationManager.getApplication().invokeLater(() -> {
            ClaudeStatusBarWidget widget = ClaudeStatusBarWidget.Factory.getWidget(project);
            if (widget != null) widget.setAgent(agent);
        });
    }

    private static String formatNumber(int num) {
        if (num < 1000) return String.valueOf(num);
        if (num < 1000000) return String.format("%.1fk", num / 1000.0);
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

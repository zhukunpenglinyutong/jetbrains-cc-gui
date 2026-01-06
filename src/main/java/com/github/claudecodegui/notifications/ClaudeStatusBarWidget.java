package com.github.claudecodegui.notifications;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.CustomStatusBarWidget;
import com.intellij.openapi.wm.StatusBar;
import com.intellij.openapi.wm.StatusBarWidget;
import com.intellij.openapi.wm.StatusBarWidgetFactory;
import com.intellij.openapi.wm.WindowManager;
import com.intellij.openapi.wm.ToolWindowManager;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Minimalist StatusBar widget for Claude AI
 */
public class ClaudeStatusBarWidget implements CustomStatusBarWidget, StatusBarWidget, Disposable {
    private final Project project;
    private StatusBar statusBar;
    private JLabel label;
    private final AtomicReference<String> textRef = new AtomicReference<>("Claude 🤖");
    private final AtomicReference<String> tooltipRef = new AtomicReference<>("Claude AI Assistant (Ctrl+Alt+K)");
    private long visibleUntil = 0;
    
    // State for display
    private String currentStatus = "ready";
    private String currentTokenInfo = "";
    private String currentModel = "";
    private String currentMode = "default";
    private String currentAgent = "";

    public ClaudeStatusBarWidget(Project project) {
        this.project = project;
    }

    @Override
    public @NotNull String ID() { return "ClaudeStatusBarWidget"; }

    @Override
    public @NotNull WidgetPresentation getPresentation() { 
        return new WidgetPresentation() {
            @Nullable @Override public String getTooltipText() { return tooltipRef.get(); }
            @Nullable @Override public com.intellij.util.Consumer<MouseEvent> getClickConsumer() { return null; }
        };
    }

    @Override
    public @NotNull JComponent getComponent() {
        if (label == null) {
            label = new JLabel(textRef.get());
            label.setBorder(BorderFactory.createEmptyBorder(0, 4, 0, 4));
            label.setToolTipText(tooltipRef.get());
            label.addMouseListener(new MouseAdapter() {
                @Override
                public void mouseClicked(MouseEvent e) {
                    ToolWindowManager.getInstance(project).getToolWindow("Claude Code GUI").activate(null);
                }
            });
        }
        return label;
    }

    @Override
    public void install(@NotNull StatusBar statusBar) { this.statusBar = statusBar; }

    @Override
    public void dispose() { this.statusBar = null; } // Kept original dispose as the provided one was for a different context

    public void updateStatus(String status, String details) {
        this.currentStatus = status;
        refreshDisplay(details);
    }
    
    public void setTokenInfo(String tokenInfo) {
        this.currentTokenInfo = tokenInfo;
        refreshDisplay(null);
    }

    public void setModel(String model) {
        this.currentModel = model;
        refreshDisplay(null);
    }

    public void setMode(String mode) {
        this.currentMode = mode;
        refreshDisplay(null);
    }

    public void setAgent(String agent) {
        this.currentAgent = agent;
        refreshDisplay(null);
    }
    
    private void refreshDisplay(String details) {
        String icon = switch (currentStatus) {
            case "thinking" -> "💭";
            case "generating" -> "✏️";
            case "waiting" -> "⏳";
            case "success" -> "✓";
            case "error" -> "✗";
            default -> "🤖";
        };

        String statusText = "";
        if ("thinking".equals(currentStatus)) {
            statusText = "Thinking...";
        } else if ("generating".equals(currentStatus)) {
            statusText = "Generating...";
        } else if ("waiting".equals(currentStatus)) {
            statusText = "Waiting...";
        } else if ("error".equals(currentStatus)) {
            statusText = "Error";
        }
        
        StringBuilder text = new StringBuilder("Claude " + icon);
        
        // Add Model Info (Shorten names)
        if (currentModel != null && !currentModel.isEmpty()) {
            String shortModel = currentModel;
            if (currentModel.contains("sonnet")) shortModel = "Sonnet";
            else if (currentModel.contains("opus")) shortModel = "Opus";
            else if (currentModel.contains("haiku")) shortModel = "Haiku";
            text.append(" [").append(shortModel).append("]");
        }

        // Add Mode Info
        if (currentMode != null && !"default".equals(currentMode)) {
            String modeLabel = switch (currentMode) {
                case "plan" -> "Plan";
                case "acceptEdits" -> "Agent";
                case "bypassPermissions" -> "Auto";
                default -> currentMode;
            };
            text.append(" {").append(modeLabel).append("}");
        }

        // Add Agent Info
        if (currentAgent != null && !currentAgent.isEmpty()) {
            text.append(" @").append(currentAgent);
        }

        if (!statusText.isEmpty()) {
            text.append(" ").append(statusText);
        }

        if (currentTokenInfo != null && !currentTokenInfo.isEmpty()) {
            text.append(" ").append(currentTokenInfo);
        }
        
        String tooltip = "Status: " + currentStatus 
            + (currentModel != null && !currentModel.isEmpty() ? "\nModel: " + currentModel : "")
            + (currentMode != null ? "\nMode: " + currentMode : "")
            + (currentAgent != null && !currentAgent.isEmpty() ? "\nAgent: " + currentAgent : "")
            + (details != null ? "\nDetails: " + details : "");
            
        updateLabel(text.toString(), tooltip);
    }

    public void show(String text, String tooltip, long durationMs) {
        this.visibleUntil = System.currentTimeMillis() + durationMs;
        // Temporary override
        updateLabel(text, tooltip);
        new Timer((int) durationMs, e -> hide()).start();
    }

    public void hide() {
        if (System.currentTimeMillis() >= visibleUntil) {
            // Revert to standard display
            refreshDisplay(null);
        }
    }

    private void updateLabel(String text, String tooltip) {
        textRef.set(text);
        tooltipRef.set(tooltip);
        if (label != null) {
            label.setText(text);
            label.setToolTipText(tooltip);
        }
        if (statusBar != null) statusBar.updateWidget(ID());
    }

    public static class Factory implements StatusBarWidgetFactory {
        @Override public @NotNull String getId() { return "ClaudeStatusBarWidget"; }
        @Override public @NotNull String getDisplayName() { return "Claude Task Status"; }
        @Override public boolean isAvailable(@NotNull Project project) { return project != null; }
        @Override public @NotNull StatusBarWidget createWidget(@NotNull Project project) { return new ClaudeStatusBarWidget(project); }
        @Override public void disposeWidget(@NotNull StatusBarWidget widget) { widget.dispose(); }

        public static ClaudeStatusBarWidget getWidget(Project project) {
            StatusBar statusBar = WindowManager.getInstance().getStatusBar(project);
            if (statusBar != null) {
                StatusBarWidget widget = statusBar.getWidget("ClaudeStatusBarWidget");
                if (widget instanceof ClaudeStatusBarWidget) return (ClaudeStatusBarWidget) widget;
            }
            return null;
        }
    }
}

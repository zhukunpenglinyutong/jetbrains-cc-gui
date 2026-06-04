package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.util.TokenUsageUtils;
import com.github.claudecodegui.util.IgnoreRuleMatcher;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.vfs.VirtualFile;

import java.util.List;

/**
 * Handles usage statistics push and context bar refresh operations.
 */
public class UsagePushService {

    private static final Logger LOG = Logger.getInstance(UsagePushService.class);

    private final HandlerContext context;
    private final Gson gson = new Gson();

    public UsagePushService(HandlerContext context) {
        this.context = context;
    }

    /**
     * Push usage update after model switch.
     * Recalculates percentage and maxTokens based on the new model's context limit.
     */
    public void pushUsageUpdateAfterModelChange(int newMaxTokens) {
        try {
            ClaudeSession session = context.getSession();
            if (session == null) {
                // Even without a session, send update so frontend knows the new maxTokens
                sendUsageUpdate(0, newMaxTokens);
                return;
            }

            // Extract the latest usage information from the current session
            List<ClaudeSession.Message> messages = session.getMessages();
            JsonObject lastUsage = TokenUsageUtils.findLastUsageFromSessionMessages(messages);
            if (lastUsage == null) {
                // No usage data available yet — send update with zero used tokens
                sendUsageUpdate(0, newMaxTokens);
                return;
            }

            // Extract detailed token information
            int usedTokens = TokenUsageUtils.extractUsedTokens(lastUsage, context.getCurrentProvider());
            int inputTokens = lastUsage.has("input_tokens") ? lastUsage.get("input_tokens").getAsInt() : 0;
            int outputTokens = lastUsage.has("output_tokens") ? lastUsage.get("output_tokens").getAsInt() : 0;
            int cacheCreationTokens = lastUsage.has("cache_creation_input_tokens") ? lastUsage.get("cache_creation_input_tokens").getAsInt() : 0;
            int cacheReadTokens = lastUsage.has("cache_read_input_tokens") ? lastUsage.get("cache_read_input_tokens").getAsInt() : 0;

            // Send update with detailed breakdown
            sendUsageUpdate(usedTokens, newMaxTokens, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);

        } catch (Exception e) {
            LOG.error("[UsagePushService] Failed to push usage update after model change: " + e.getMessage(), e);
        }
    }

    /**
     * Send usage update to the frontend with detailed token breakdown.
     */
    public void sendUsageUpdate(int usedTokens, int maxTokens) {
        sendUsageUpdate(usedTokens, maxTokens, 0, 0, 0, 0);
    }

    /**
     * Send usage update to the frontend with detailed token breakdown.
     */
    public void sendUsageUpdate(int usedTokens, int maxTokens, int inputTokens, int outputTokens,
                                int cacheCreationTokens, int cacheReadTokens) {
        int percentage = Math.min(100, maxTokens > 0 ? (int) ((usedTokens * 100.0) / maxTokens) : 0);

        LOG.info("[UsagePushService] Sending usage update: usedTokens=" + usedTokens + ", maxTokens=" + maxTokens +
                 ", percentage=" + percentage + "%");

        JsonObject rawUsage = new JsonObject();
        rawUsage.addProperty("input_tokens", inputTokens);
        rawUsage.addProperty("output_tokens", outputTokens);
        rawUsage.addProperty("cache_creation_input_tokens", cacheCreationTokens);
        rawUsage.addProperty("cache_read_input_tokens", cacheReadTokens);
        JsonObject usageUpdate = TokenUsageUtils.buildUsageUpdatePayload(rawUsage, context.getCurrentProvider(), maxTokens);

        String usageJson = gson.toJson(usageUpdate);

        // Push to frontend (must be executed on the EDT thread)
        ApplicationManager.getApplication().invokeLater(() -> {
            if (context.getBrowser() != null && !context.isDisposed()) {
                String js = "(function() {" +
                        "  if (typeof window.onUsageUpdate === 'function') {" +
                        "    window.onUsageUpdate('" + context.escapeJs(usageJson) + "');" +
                        "  }" +
                        "})();";
                context.getBrowser().getCefBrowser().executeJavaScript(js, context.getBrowser().getCefBrowser().getURL(), 0);
            } else {
                LOG.warn("[UsagePushService] Cannot send usage update: browser is null or disposed");
            }
        });
    }

    /**
     * Refresh the context bar with the currently open editor file.
     */
    public void refreshContextBar() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (context.getProject() == null) {
                    return;
                }

                // Check if auto-open file is enabled
                String projectPath = context.getProject().getBasePath();
                if (projectPath != null) {
                    CodemossSettingsService settingsService = new CodemossSettingsService();
                    boolean autoOpenFileEnabled = settingsService.getAutoOpenFileEnabled(projectPath);
                    if (!autoOpenFileEnabled) {
                        // If auto-open file is disabled, clear the ContextBar display
                        context.callJavaScript("clearSelectionInfo");
                        return;
                    }
                }

                // Get cached .gitignore matcher for filtering sensitive files
                IgnoreRuleMatcher gitIgnoreMatcher = IgnoreRuleMatcher.forProjectSafe(projectPath);

                FileEditorManager editorManager = FileEditorManager.getInstance(context.getProject());
                Editor editor = editorManager.getSelectedTextEditor();
                String selectionInfo = null;

                if (editor != null) {
                    VirtualFile file = FileDocumentManager.getInstance().getFile(editor.getDocument());
                    if (file != null) {
                        String path = file.getPath();

                        // Filter out .gitignore'd files to prevent sensitive files from being auto-opened
                        if (gitIgnoreMatcher != null && gitIgnoreMatcher.isFileIgnored(path)) {
                            context.callJavaScript("clearSelectionInfo");
                            return;
                        }

                        selectionInfo = "@" + path;

                        SelectionModel selectionModel = editor.getSelectionModel();
                        if (selectionModel.hasSelection()) {
                            int startLine = editor.getDocument().getLineNumber(selectionModel.getSelectionStart()) + 1;
                            int endLine = editor.getDocument().getLineNumber(selectionModel.getSelectionEnd()) + 1;

                            if (endLine > startLine
                                    && editor.offsetToLogicalPosition(selectionModel.getSelectionEnd()).column == 0) {
                                endLine--;
                            }
                            selectionInfo += "#L" + startLine + "-" + endLine;
                        }
                    }
                } else {
                    VirtualFile[] files = editorManager.getSelectedFiles();
                    if (files.length > 0 && files[0] != null) {
                        String path = files[0].getPath();

                        // Filter out .gitignore'd files
                        if (gitIgnoreMatcher != null && gitIgnoreMatcher.isFileIgnored(path)) {
                            context.callJavaScript("clearSelectionInfo");
                            return;
                        }

                        selectionInfo = "@" + path;
                    }
                }

                if (selectionInfo != null && !selectionInfo.isEmpty()) {
                    context.callJavaScript("addSelectionInfo", context.escapeJs(selectionInfo));
                } else {
                    context.callJavaScript("clearSelectionInfo");
                }
            } catch (Exception e) {
                LOG.warn("[UsagePushService] Failed to refresh context bar: " + e.getMessage());
            }
        });
    }
}

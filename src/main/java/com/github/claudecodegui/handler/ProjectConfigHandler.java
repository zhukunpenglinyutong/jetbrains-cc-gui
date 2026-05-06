package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.action.SendShortcutSync;
import com.github.claudecodegui.provider.claude.ClaudeHistoryReader;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.util.FontConfigService;
import com.github.claudecodegui.util.ThemeConfigService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;

import java.util.concurrent.CompletableFuture;

/**
 * Handles project-level configuration: working directory, streaming, sandbox mode,
 * auto-open file, send shortcut, commit prompt, IDE theme, editor font config, and usage statistics.
 */
public class ProjectConfigHandler {

    private static final Logger LOG = Logger.getInstance(ProjectConfigHandler.class);
    static final String SEND_SHORTCUT_PROPERTY_KEY = "claude.code.send.shortcut";

    private final HandlerContext context;
    private final CodemossSettingsService settingsService;
    private final Gson gson = new Gson();

    public ProjectConfigHandler(HandlerContext context) {
        this.context = context;
        this.settingsService = context.getSettingsService();
    }

    public void handleGetWorkingDirectory() {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.updateWorkingDirectory", "{}"));
                return;
            }
            String customWorkingDir = new CodemossSettingsService().getCustomWorkingDirectory(projectPath);
            JsonObject response = new JsonObject();
            response.addProperty("projectPath", projectPath);
            response.addProperty("customWorkingDir", customWorkingDir != null ? customWorkingDir : "");
            String json = gson.toJson(response);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.updateWorkingDirectory", context.escapeJs(json)));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get working directory: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("获取工作目录配置失败: " + e.getMessage())));
        }
    }

    public void handleSetWorkingDirectory(String content) {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs("无法获取项目路径")));
                return;
            }
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String customWorkingDir = (json != null && json.has("customWorkingDir") && !json.get("customWorkingDir").isJsonNull())
                ? json.get("customWorkingDir").getAsString() : null;
            if (customWorkingDir != null && !customWorkingDir.trim().isEmpty()) {
                java.io.File workingDirFile = new java.io.File(customWorkingDir);
                if (!workingDirFile.isAbsolute()) {
                    workingDirFile = new java.io.File(projectPath, customWorkingDir);
                }
                if (!workingDirFile.exists() || !workingDirFile.isDirectory()) {
                    final String errorPath = workingDirFile.getAbsolutePath();
                    ApplicationManager.getApplication().invokeLater(() ->
                        context.callJavaScript("window.showError", context.escapeJs("工作目录不存在: " + errorPath)));
                    return;
                }
            }
            new CodemossSettingsService().setCustomWorkingDirectory(projectPath, customWorkingDir);
            LOG.info("[ProjectConfigHandler] Set custom working directory: " + customWorkingDir);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showSuccess", context.escapeJs("工作目录配置已保存")));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set working directory: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("保存工作目录配置失败: " + e.getMessage())));
        }
    }

    public void handleGetStreamingEnabled() {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    JsonObject r = new JsonObject();
                    r.addProperty("streamingEnabled", true);
                    context.callJavaScript("window.updateStreamingEnabled", context.escapeJs(gson.toJson(r)));
                });
                return;
            }
            boolean streamingEnabled = new CodemossSettingsService().getStreamingEnabled(projectPath);
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("streamingEnabled", streamingEnabled);
                context.callJavaScript("window.updateStreamingEnabled", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get streaming enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("streamingEnabled", true);
                context.callJavaScript("window.updateStreamingEnabled", context.escapeJs(gson.toJson(r)));
            });
        }
    }

    public void handleSetStreamingEnabled(String content) {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs("无法获取项目路径")));
                return;
            }
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean streamingEnabled = (json == null || !json.has("streamingEnabled") || json.get("streamingEnabled").isJsonNull())
                || json.get("streamingEnabled").getAsBoolean();
            new CodemossSettingsService().setStreamingEnabled(projectPath, streamingEnabled);
            LOG.info("[ProjectConfigHandler] Set streaming enabled: " + streamingEnabled);
            final boolean finalVal = streamingEnabled;
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("streamingEnabled", finalVal);
                context.callJavaScript("window.updateStreamingEnabled", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set streaming enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("保存流式传输配置失败: " + e.getMessage())));
        }
    }

    public void handleGetCodexSandboxMode() {
        try {
            String projectPath = context.getProject().getBasePath();
            String sandboxMode = settingsService.getCodexSandboxMode(projectPath);
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("sandboxMode", sandboxMode);
                context.callJavaScript("window.updateCodexSandboxMode", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get Codex sandbox mode: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("sandboxMode", "danger-full-access");
                context.callJavaScript("window.updateCodexSandboxMode", context.escapeJs(gson.toJson(r)));
            });
        }
    }

    public void handleSetCodexSandboxMode(String content) {
        try {
            String projectPath = context.getProject().getBasePath();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String sandboxMode = (json != null && json.has("sandboxMode") && !json.get("sandboxMode").isJsonNull())
                ? json.get("sandboxMode").getAsString() : "danger-full-access";
            settingsService.setCodexSandboxMode(projectPath, sandboxMode);
            LOG.info("[ProjectConfigHandler] Set Codex sandbox mode: " + sandboxMode);
            final String finalMode = sandboxMode;
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("sandboxMode", finalMode);
                context.callJavaScript("window.updateCodexSandboxMode", context.escapeJs(gson.toJson(r)));
                context.callJavaScript("window.showSuccessI18n", "toast.saveSuccess");
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set Codex sandbox mode: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("Failed to save Codex sandbox mode: " + e.getMessage())));
        }
    }

    public void handleGetAutoOpenFileEnabled() {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    JsonObject r = new JsonObject();
                    r.addProperty("autoOpenFileEnabled", false);
                    context.callJavaScript("window.updateAutoOpenFileEnabled", context.escapeJs(gson.toJson(r)));
                });
                return;
            }
            boolean enabled = new CodemossSettingsService().getAutoOpenFileEnabled(projectPath);
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("autoOpenFileEnabled", enabled);
                context.callJavaScript("window.updateAutoOpenFileEnabled", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get auto open file enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("autoOpenFileEnabled", false);
                context.callJavaScript("window.updateAutoOpenFileEnabled", context.escapeJs(gson.toJson(r)));
            });
        }
    }

    public void handleSetAutoOpenFileEnabled(String content) {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs("无法获取项目路径")));
                return;
            }
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean enabled = json != null && json.has("autoOpenFileEnabled") && !json.get("autoOpenFileEnabled").isJsonNull()
                && json.get("autoOpenFileEnabled").getAsBoolean();
            new CodemossSettingsService().setAutoOpenFileEnabled(projectPath, enabled);
            LOG.info("[ProjectConfigHandler] Set auto open file enabled: " + enabled);
            final boolean finalVal = enabled;
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("autoOpenFileEnabled", finalVal);
                context.callJavaScript("window.updateAutoOpenFileEnabled", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set auto open file enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("保存自动打开文件配置失败: " + e.getMessage())));
        }
    }

    public void handleGetSendShortcut() {
        try {
            String sendShortcut = PropertiesComponent.getInstance().getValue(SEND_SHORTCUT_PROPERTY_KEY, "enter");
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("sendShortcut", sendShortcut);
                context.callJavaScript("window.updateSendShortcut", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get send shortcut: " + e.getMessage(), e);
        }
    }

    public void handleSetSendShortcut(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String sendShortcut = (json != null && json.has("sendShortcut") && !json.get("sendShortcut").isJsonNull())
                ? json.get("sendShortcut").getAsString() : "enter";
            if (!"enter".equals(sendShortcut) && !"cmdEnter".equals(sendShortcut)) {
                sendShortcut = "enter";
            }
            PropertiesComponent.getInstance().setValue(SEND_SHORTCUT_PROPERTY_KEY, sendShortcut);
            SendShortcutSync.sync(sendShortcut);
            LOG.info("[ProjectConfigHandler] Set send shortcut: " + sendShortcut);
            final String finalShortcut = sendShortcut;
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("sendShortcut", finalShortcut);
                context.callJavaScript("window.updateSendShortcut", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set send shortcut: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("保存发送快捷键设置失败: " + e.getMessage())));
        }
    }

    public void handleGetCommitPrompt() {
        try {
            String commitPrompt = new CodemossSettingsService().getCommitPrompt();
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("commitPrompt", commitPrompt);
                context.callJavaScript("window.updateCommitPrompt", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get commit prompt: " + e.getMessage(), e);
        }
    }

    public void handleSetCommitPrompt(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            if (json == null || !json.has("prompt")) {
                LOG.warn("[ProjectConfigHandler] Invalid commit prompt request: missing prompt field");
                return;
            }
            String prompt = json.get("prompt").getAsString();
            if (prompt == null) {
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs("提示词不能为空")));
                return;
            }
            prompt = prompt.trim();
            final int MAX_PROMPT_LENGTH = 10000;
            if (prompt.length() > MAX_PROMPT_LENGTH) {
                LOG.warn("[ProjectConfigHandler] Commit prompt too long: " + prompt.length() + " characters");
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs("提示词长度不能超过 " + MAX_PROMPT_LENGTH + " 字符")));
                return;
            }
            final String validatedPrompt = prompt;
            new CodemossSettingsService().setCommitPrompt(validatedPrompt);
            LOG.info("[ProjectConfigHandler] Set commit prompt, length: " + validatedPrompt.length());
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("commitPrompt", validatedPrompt);
                r.addProperty("saved", true);
                context.callJavaScript("window.updateCommitPrompt", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set commit prompt: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("保存 Commit 提示词失败: " + e.getMessage())));
        }
    }

    public void handleGetPromptEnhancerConfig() {
        try {
            JsonObject config = settingsService.getPromptEnhancerConfig();
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.updatePromptEnhancerConfig", context.escapeJs(gson.toJson(config))));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get prompt enhancer config: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs(
                    ClaudeCodeGuiBundle.message("projectConfig.promptEnhancer.getFailed", e.getMessage()))));
        }
    }

    public void handleSetPromptEnhancerConfig(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String provider = json != null && json.has("provider") && !json.get("provider").isJsonNull()
                    ? json.get("provider").getAsString()
                    : null;

            JsonObject models = json != null && json.has("models") && json.get("models").isJsonObject()
                    ? json.getAsJsonObject("models")
                    : new JsonObject();
            String claudeModel = models.has("claude") && !models.get("claude").isJsonNull()
                    ? models.get("claude").getAsString()
                    : null;
            String codexModel = models.has("codex") && !models.get("codex").isJsonNull()
                    ? models.get("codex").getAsString()
                    : null;

            settingsService.setPromptEnhancerConfig(provider, claudeModel, codexModel);
            JsonObject updatedConfig = settingsService.getPromptEnhancerConfig();
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.updatePromptEnhancerConfig", context.escapeJs(gson.toJson(updatedConfig))));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set prompt enhancer config: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs(
                    ClaudeCodeGuiBundle.message("projectConfig.promptEnhancer.saveFailed", e.getMessage()))));
        }
    }

    public void handleGetCommitAiConfig() {
        try {
            JsonObject config = settingsService.getCommitAiConfig();
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.updateCommitAiConfig", context.escapeJs(gson.toJson(config))));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get commit AI config: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs(
                    ClaudeCodeGuiBundle.message("projectConfig.commitAi.getFailed", e.getMessage()))));
        }
    }

    public void handleSetCommitAiConfig(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String provider = json != null && json.has("provider") && !json.get("provider").isJsonNull()
                    ? json.get("provider").getAsString()
                    : null;

            JsonObject models = json != null && json.has("models") && json.get("models").isJsonObject()
                    ? json.getAsJsonObject("models")
                    : new JsonObject();
            String claudeModel = models.has("claude") && !models.get("claude").isJsonNull()
                    ? models.get("claude").getAsString()
                    : null;
            String codexModel = models.has("codex") && !models.get("codex").isJsonNull()
                    ? models.get("codex").getAsString()
                    : null;

            settingsService.setCommitAiConfig(provider, claudeModel, codexModel);
            JsonObject updatedConfig = settingsService.getCommitAiConfig();
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.updateCommitAiConfig", context.escapeJs(gson.toJson(updatedConfig))));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set commit AI config: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs(
                    ClaudeCodeGuiBundle.message("projectConfig.commitAi.saveFailed", e.getMessage()))));
        }
    }

    public void handleGetIdeTheme() {
        try {
            String themeConfigJson = ThemeConfigService.getIdeThemeConfig().toString();
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.onIdeThemeReceived", context.escapeJs(themeConfigJson)));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get IDE theme: " + e.getMessage(), e);
        }
    }

    public void handleGetEditorFontConfig() {
        try {
            String fontConfigJson = FontConfigService.getEditorFontConfig().toString();
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.onEditorFontConfigReceived", context.escapeJs(fontConfigJson)));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get editor font config: " + e.getMessage(), e);
        }
    }

    public void handleGetUiFontConfig() {
        dispatchUiFontConfigUpdate();
    }

    public void handleSetUiFontConfig(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String mode = json != null && json.has("mode") && !json.get("mode").isJsonNull()
                ? json.get("mode").getAsString()
                : FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR;
            String customFontPath = json != null && json.has("customFontPath") && !json.get("customFontPath").isJsonNull()
                ? json.get("customFontPath").getAsString()
                : null;

            if (FontConfigService.UI_FONT_MODE_CUSTOM_FILE.equals(mode)) {
                FontConfigService.ValidationResult validation = FontConfigService.validateCustomUiFontFile(customFontPath);
                if (!validation.valid()) {
                    final String errorMessage = validation.errorMessage();
                    ApplicationManager.getApplication().invokeLater(() ->
                        context.callJavaScript("window.showError", context.escapeJs("Invalid font file: " + errorMessage)));
                    return;
                }
            }

            settingsService.setUiFontConfig(mode, customFontPath);
            dispatchUiFontConfigUpdate();
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set UI font config: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("Failed to save font config: " + e.getMessage())));
        }
    }

    public void handleBrowseUiFontFile() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                FileChooserDescriptor descriptor = new FileChooserDescriptor(
                    true, false, false, false, false, false
                )
                    .withFileFilter(file -> {
                        String extension = file.getExtension();
                        return extension != null && (
                            extension.equalsIgnoreCase("ttf") ||
                            extension.equalsIgnoreCase("otf")
                        );
                    })
                    .withTitle("Select Font File")
                    .withDescription("Select a TTF or OTF font file");

                VirtualFile initialFile = null;
                try {
                    JsonObject persistedUiFont = settingsService.getUiFontConfig();
                    if (persistedUiFont.has("customFontPath") && !persistedUiFont.get("customFontPath").isJsonNull()) {
                        initialFile = LocalFileSystem.getInstance()
                            .findFileByPath(persistedUiFont.get("customFontPath").getAsString());
                    }
                } catch (Exception e) {
                    LOG.warn("[ProjectConfigHandler] Failed to resolve current custom font path: " + e.getMessage());
                }

                FileChooser.chooseFile(descriptor, context.getProject(), initialFile, file -> {
                    if (file == null) {
                        return;
                    }

                    String path = file.getPath();
                    FontConfigService.ValidationResult validation = FontConfigService.validateCustomUiFontFile(path);
                    if (!validation.valid()) {
                        context.callJavaScript("window.showError",
                            context.escapeJs("Invalid font file: " + validation.errorMessage()));
                        return;
                    }

                    try {
                        settingsService.setUiFontConfig(FontConfigService.UI_FONT_MODE_CUSTOM_FILE, path);
                        dispatchUiFontConfigUpdate();
                        context.callJavaScript("window.showSuccessI18n", context.escapeJs("toast.saveSuccess"));
                    } catch (Exception e) {
                        LOG.error("[ProjectConfigHandler] Failed to save selected font file: " + e.getMessage(), e);
                        context.callJavaScript("window.showError", context.escapeJs("Failed to save font config: " + e.getMessage()));
                    }
                });
            } catch (Exception e) {
                LOG.error("[ProjectConfigHandler] Failed to open font file chooser: " + e.getMessage(), e);
            }
        });
    }

    // ==================== AI Feature Toggle ====================

    public void handleGetCommitGenerationEnabled() {
        try {
            boolean enabled = settingsService.getCommitGenerationEnabled();
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("commitGenerationEnabled", enabled);
                context.callJavaScript("window.updateCommitGenerationEnabled", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get commit generation enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("commitGenerationEnabled", true);
                context.callJavaScript("window.updateCommitGenerationEnabled", context.escapeJs(gson.toJson(r)));
            });
        }
    }

    public void handleSetCommitGenerationEnabled(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean enabled = json == null || !json.has("commitGenerationEnabled") || json.get("commitGenerationEnabled").isJsonNull()
                || json.get("commitGenerationEnabled").getAsBoolean();
            settingsService.setCommitGenerationEnabled(enabled);
            LOG.info("[ProjectConfigHandler] Set commit generation enabled: " + enabled);
            final boolean finalVal = enabled;
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("commitGenerationEnabled", finalVal);
                context.callJavaScript("window.updateCommitGenerationEnabled", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set commit generation enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("保存 AI 生成 Commit 配置失败")));
        }
    }

    public void handleGetAiTitleGenerationEnabled() {
        try {
            boolean enabled = settingsService.getAiTitleGenerationEnabled();
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("aiTitleGenerationEnabled", enabled);
                context.callJavaScript("window.updateAiTitleGenerationEnabled", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get AI title generation enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("aiTitleGenerationEnabled", true);
                context.callJavaScript("window.updateAiTitleGenerationEnabled", context.escapeJs(gson.toJson(r)));
            });
        }
    }

    public void handleSetAiTitleGenerationEnabled(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean enabled = json == null || !json.has("aiTitleGenerationEnabled") || json.get("aiTitleGenerationEnabled").isJsonNull()
                || json.get("aiTitleGenerationEnabled").getAsBoolean();
            settingsService.setAiTitleGenerationEnabled(enabled);
            LOG.info("[ProjectConfigHandler] Set AI title generation enabled: " + enabled);
            final boolean finalVal = enabled;
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("aiTitleGenerationEnabled", finalVal);
                context.callJavaScript("window.updateAiTitleGenerationEnabled", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set AI title generation enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("保存 AI 标题生成配置失败")));
        }
    }

    public void handleGetStatusBarWidgetEnabled() {
        try {
            boolean enabled = settingsService.getStatusBarWidgetEnabled();
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("statusBarWidgetEnabled", enabled);
                context.callJavaScript("window.updateStatusBarWidgetEnabled", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get status bar widget enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("statusBarWidgetEnabled", true);
                context.callJavaScript("window.updateStatusBarWidgetEnabled", context.escapeJs(gson.toJson(r)));
            });
        }
    }

    public void handleSetStatusBarWidgetEnabled(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean enabled = json == null || !json.has("statusBarWidgetEnabled") || json.get("statusBarWidgetEnabled").isJsonNull()
                || json.get("statusBarWidgetEnabled").getAsBoolean();
            settingsService.setStatusBarWidgetEnabled(enabled);
            LOG.info("[ProjectConfigHandler] Set status bar widget enabled: " + enabled);
            final boolean finalVal = enabled;
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject r = new JsonObject();
                r.addProperty("statusBarWidgetEnabled", finalVal);
                context.callJavaScript("window.updateStatusBarWidgetEnabled", context.escapeJs(gson.toJson(r)));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set status bar widget enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("保存状态栏配置失败")));
        }
    }

    private void dispatchUiFontConfigUpdate() {
        try {
            String uiFontConfigJson = FontConfigService.getResolvedUiFontConfigJson(settingsService);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.onUiFontConfigReceived", context.escapeJs(uiFontConfigJson));
                context.callJavaScript("window.applyUiFontConfig", context.escapeJs(uiFontConfigJson));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to dispatch UI font config: " + e.getMessage(), e);
        }
    }

    /** Get usage statistics. Supports both Claude and Codex providers. */
    public void handleGetUsageStatistics(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                String projectPath = "all";
                String provider = "claude";
                long cutoffTime = 0;
                if (content != null && !content.isEmpty() && !content.equals("{}")) {
                    try {
                        JsonObject json = gson.fromJson(content, JsonObject.class);
                        if (json.has("scope")) {
                            projectPath = "current".equals(json.get("scope").getAsString())
                                ? context.getProject().getBasePath() : "all";
                        }
                        if (json.has("provider")) {
                            provider = json.get("provider").getAsString();
                        }
                        if (json.has("dateRange")) {
                            String dateRange = json.get("dateRange").getAsString();
                            long now = System.currentTimeMillis();
                            if ("7d".equals(dateRange)) cutoffTime = now - 7L * 24 * 60 * 60 * 1000;
                            else if ("30d".equals(dateRange)) cutoffTime = now - 30L * 24 * 60 * 60 * 1000;
                        }
                    } catch (Exception e) {
                        projectPath = "current".equals(content) ? context.getProject().getBasePath() : content;
                    }
                }
                String json;
                if ("codex".equals(provider)) {
                    CodexHistoryReader reader = new CodexHistoryReader();
                    CodexHistoryReader.ProjectStatistics stats = reader.getProjectStatistics(projectPath, cutoffTime);
                    LOG.info("[ProjectConfigHandler] Codex statistics - sessions: " + stats.totalSessions +
                             ", cost: " + stats.estimatedCost + ", total tokens: " + stats.totalUsage.totalTokens);
                    json = gson.toJson(stats);
                } else {
                    ClaudeHistoryReader reader = new ClaudeHistoryReader();
                    json = gson.toJson(reader.getProjectStatistics(projectPath, cutoffTime));
                }
                final String statsJson = json;
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.updateUsageStatistics", context.escapeJs(statsJson)));
            } catch (Exception e) {
                LOG.error("[ProjectConfigHandler] Failed to get usage statistics: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs("获取统计数据失败: " + e.getMessage())));
            }
        });
    }
}

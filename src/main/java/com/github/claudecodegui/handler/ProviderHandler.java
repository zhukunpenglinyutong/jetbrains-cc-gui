package com.github.claudecodegui.handler;

import com.github.claudecodegui.model.DeleteResult;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.vfs.VirtualFile;

import javax.swing.*;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Provider management message handler.
 * Handles provider CRUD operations and switching.
 * Supports both Claude and Codex providers.
 */
public class ProviderHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(ProviderHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        // Claude provider operations
        "get_providers",
        "get_current_claude_config",
        "get_thinking_enabled",
        "set_thinking_enabled",
        "add_provider",
        "update_provider",
        "delete_provider",
        "switch_provider",
        "get_active_provider",
        "preview_cc_switch_import",
        "open_file_chooser_for_cc_switch",
        "save_imported_providers",
        // Codex provider operations
        "get_codex_providers",
        "get_current_codex_config",
        "add_codex_provider",
        "update_codex_provider",
        "delete_codex_provider",
        "switch_codex_provider",
        "get_active_codex_provider"
    };

    public ProviderHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            // Claude provider operations
            case "get_providers":
                handleGetProviders();
                return true;
            case "get_current_claude_config":
                handleGetCurrentClaudeConfig();
                return true;
            case "get_thinking_enabled":
                handleGetThinkingEnabled();
                return true;
            case "set_thinking_enabled":
                handleSetThinkingEnabled(content);
                return true;
            case "add_provider":
                handleAddProvider(content);
                return true;
            case "update_provider":
                handleUpdateProvider(content);
                return true;
            case "delete_provider":
                handleDeleteProvider(content);
                return true;
            case "switch_provider":
                handleSwitchProvider(content);
                return true;
            case "get_active_provider":
                handleGetActiveProvider();
                return true;
            case "preview_cc_switch_import":
                handlePreviewCcSwitchImport();
                return true;
            case "open_file_chooser_for_cc_switch":
                handleOpenFileChooserForCcSwitch();
                return true;
            case "save_imported_providers":
                handleSaveImportedProviders(content);
                return true;
            // Codex provider operations
            case "get_codex_providers":
                handleGetCodexProviders();
                return true;
            case "get_current_codex_config":
                handleGetCurrentCodexConfig();
                return true;
            case "add_codex_provider":
                handleAddCodexProvider(content);
                return true;
            case "update_codex_provider":
                handleUpdateCodexProvider(content);
                return true;
            case "delete_codex_provider":
                handleDeleteCodexProvider(content);
                return true;
            case "switch_codex_provider":
                handleSwitchCodexProvider(content);
                return true;
            case "get_active_codex_provider":
                handleGetActiveCodexProvider();
                return true;
            default:
                return false;
        }
    }

    private void handleGetThinkingEnabled() {
        try {
            Boolean enabled = context.getSettingsService().getAlwaysThinkingEnabledFromClaudeSettings();
            boolean value = enabled != null ? enabled : true;

            JsonObject payload = new JsonObject();
            payload.addProperty("enabled", value);
            payload.addProperty("explicit", enabled != null);

            Gson gson = new Gson();
            String json = gson.toJson(payload);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateThinkingEnabled", escapeJs(json));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to get thinking enabled: " + e.getMessage(), e);
        }
    }

    private void handleSetThinkingEnabled(String content) {
        try {
            Gson gson = new Gson();
            Boolean enabled = null;
            if (content != null && !content.trim().isEmpty()) {
                try {
                    JsonObject data = gson.fromJson(content, JsonObject.class);
                    if (data != null && data.has("enabled") && !data.get("enabled").isJsonNull()) {
                        enabled = data.get("enabled").getAsBoolean();
                    }
                } catch (Exception ignored) {
                }
            }

            if (enabled == null) {
                enabled = Boolean.parseBoolean(content != null ? content.trim() : "false");
            }

            context.getSettingsService().setAlwaysThinkingEnabledInClaudeSettings(enabled);
            try {
                context.getSettingsService().setAlwaysThinkingEnabledInActiveProvider(enabled);
            } catch (Exception ignored) {
            }

            JsonObject payload = new JsonObject();
            payload.addProperty("enabled", enabled);
            payload.addProperty("explicit", true);
            String json = gson.toJson(payload);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateThinkingEnabled", escapeJs(json));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to set thinking enabled: " + e.getMessage(), e);
        }
    }

    /**
     * Get all providers.
     */
    private void handleGetProviders() {
        try {
            List<JsonObject> providers = context.getSettingsService().getClaudeProviders();
            Gson gson = new Gson();
            String providersJson = gson.toJson(providers);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateProviders", escapeJs(providersJson));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to get providers: " + e.getMessage(), e);
        }
    }

    /**
     * Get current Claude CLI configuration (~/.claude/settings.json).
     */
    private void handleGetCurrentClaudeConfig() {
        try {
            JsonObject config = context.getSettingsService().getCurrentClaudeConfig();
            Gson gson = new Gson();
            String configJson = gson.toJson(config);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateCurrentClaudeConfig", escapeJs(configJson));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to get current claude config: " + e.getMessage(), e);
        }
    }

    /**
     * Add a provider.
     */
    private void handleAddProvider(String content) {
        try {
            Gson gson = new Gson();
            JsonObject provider = gson.fromJson(content, JsonObject.class);
            context.getSettingsService().addClaudeProvider(provider);

            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetProviders(); // Refresh list
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to add provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.addFailed", e.getMessage())));
            });
        }
    }

    /**
     * Update a provider.
     */
    private void handleUpdateProvider(String content) {
        try {
            Gson gson = new Gson();
            JsonObject data = gson.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();
            JsonObject updates = data.getAsJsonObject("updates");

            context.getSettingsService().updateClaudeProvider(id, updates);

            boolean syncedActiveProvider = false;
            JsonObject activeProvider = context.getSettingsService().getActiveClaudeProvider();
            if (activeProvider != null &&
                activeProvider.has("id") &&
                id.equals(activeProvider.get("id").getAsString())) {
                context.getSettingsService().applyProviderToClaudeSettings(activeProvider);
                syncedActiveProvider = true;
            }

            final boolean finalSynced = syncedActiveProvider;
            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetProviders(); // Refresh list
                if (finalSynced) {
                    handleGetActiveProvider(); // Refresh active provider config
                }
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to update provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.updateFailed", e.getMessage())));
            });
        }
    }

    /**
     * Delete a provider.
     */
    private void handleDeleteProvider(String content) {
        LOG.debug("[ProviderHandler] ========== handleDeleteProvider START ==========");
        LOG.debug("[ProviderHandler] Received content: " + content);

        try {
            Gson gson = new Gson();
            JsonObject data = gson.fromJson(content, JsonObject.class);
            LOG.debug("[ProviderHandler] Parsed JSON data: " + data);

            if (!data.has("id")) {
                LOG.error("[ProviderHandler] ERROR: Missing 'id' field in request");
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.deleteMissingId")));
                });
                return;
            }

            String id = data.get("id").getAsString();
            LOG.info("[ProviderHandler] Deleting provider with ID: " + id);

            DeleteResult result = context.getSettingsService().deleteClaudeProvider(id);
            LOG.debug("[ProviderHandler] Delete result - success: " + result.isSuccess());

            if (result.isSuccess()) {
                LOG.info("[ProviderHandler] Delete successful, refreshing provider list");
                ApplicationManager.getApplication().invokeLater(() -> {
                    handleGetProviders(); // Refresh list
                });
            } else {
                String errorMsg = result.getUserFriendlyMessage();
                LOG.warn("[ProviderHandler] Delete provider failed: " + errorMsg);
                LOG.warn("[ProviderHandler] Error type: " + result.getErrorType());
                LOG.warn("[ProviderHandler] Error details: " + result.getErrorMessage());
                ApplicationManager.getApplication().invokeLater(() -> {
                    LOG.debug("[ProviderHandler] Calling window.showError with: " + errorMsg);
                    callJavaScript("window.showError", escapeJs(errorMsg));
                });
            }
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Exception in handleDeleteProvider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.deleteFailed", e.getMessage())));
            });
        }

        LOG.debug("[ProviderHandler] ========== handleDeleteProvider END ==========");
    }

    /**
     * Switch provider.
     */
    private void handleSwitchProvider(String content) {
        try {
            Gson gson = new Gson();
            JsonObject data = gson.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();

            if ("__local_settings_json__".equals(id)) {
                // Validate settings.json exists
                Path settingsPath = Paths.get(System.getProperty("user.home"), ".claude", "settings.json");
                if (!Files.exists(settingsPath)) {
                    LOG.warn("[ProviderHandler] Local settings.json does not exist at: " + settingsPath);
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.showError",
                            escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("error.localProviderSettingsNotFound")));
                    });
                    return;
                }

                // Validate JSON format
                try {
                    String settingsContent = Files.readString(settingsPath);
                    gson.fromJson(settingsContent, JsonObject.class);
                } catch (JsonSyntaxException e) {
                    LOG.error("[ProviderHandler] Invalid JSON in settings.json: " + e.getMessage(), e);
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.showError",
                            escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("error.localProviderInvalidJson", e.getMessage())));
                    });
                    return;
                }

                JsonObject config = context.getSettingsService().readConfig();
                if (!config.has("claude")) {
                    JsonObject claude = new JsonObject();
                    claude.add("providers", new JsonObject());
                    claude.addProperty("current", "");
                    config.add("claude", claude);
                }
                config.getAsJsonObject("claude").addProperty("current", id);
                context.getSettingsService().writeConfig(config);

                LOG.info("[ProviderHandler] Switched to LOCAL settings.json provider");

                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.showSwitchSuccess",
                        escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("toast.localProviderSwitchSuccess")));
                    handleGetProviders();
                    handleGetCurrentClaudeConfig();
                    handleGetActiveProvider();
                });
                return;
            }

            context.getSettingsService().switchClaudeProvider(id);
            context.getSettingsService().applyActiveProviderToClaudeSettings();

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showSwitchSuccess", escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("toast.providerSwitchSuccess") + com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.switchSyncClaude")));
                handleGetProviders();
                handleGetCurrentClaudeConfig();
                handleGetActiveProvider();
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to switch provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("toast.providerSwitchFailed") + ": " + e.getMessage()));
            });
        }
    }

    /**
     * Get the currently active provider.
     */
    private void handleGetActiveProvider() {
        try {
            JsonObject provider = context.getSettingsService().getActiveClaudeProvider();
            Gson gson = new Gson();
            String providerJson = gson.toJson(provider);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateActiveProvider", escapeJs(providerJson));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to get active provider: " + e.getMessage(), e);
        }
    }

    /**
     * Preview cc-switch import.
     */
    private void handlePreviewCcSwitchImport() {
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater(() -> {
            String userHome = System.getProperty("user.home");
            String osName = System.getProperty("os.name").toLowerCase();

            File ccSwitchDir = new File(userHome, ".cc-switch");
            File dbFile = new File(ccSwitchDir, "cc-switch.db");

            LOG.info("[ProviderHandler] 操作系统: " + osName);
            LOG.info("[ProviderHandler] 用户目录: " + userHome);
            LOG.info("[ProviderHandler] cc-switch 目录: " + ccSwitchDir.getAbsolutePath());
            LOG.info("[ProviderHandler] 数据库文件路径: " + dbFile.getAbsolutePath());
            LOG.info("[ProviderHandler] 数据库文件是否存在: " + dbFile.exists());

            if (!dbFile.exists()) {
                String errorMsg = com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.notFound", dbFile.getAbsolutePath());
                LOG.error("[ProviderHandler] " + errorMsg);
                sendErrorToFrontend(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.notFoundTitle"), errorMsg);
                return;
            }

            CompletableFuture.runAsync(() -> {
                try {
                    LOG.info("[ProviderHandler] 开始读取数据库文件...");
                    Gson gson = new Gson();
                    List<JsonObject> providers = context.getSettingsService().parseProvidersFromCcSwitchDb(dbFile.getPath());

                    if (providers.isEmpty()) {
                        LOG.info("[ProviderHandler] No Claude provider configs found in database");
                        sendInfoToFrontend(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.noDataTitle"), com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.noData"));
                        return;
                    }

                    JsonArray providersArray = new JsonArray();
                    for (JsonObject p : providers) {
                        providersArray.add(p);
                    }

                    JsonObject response = new JsonObject();
                    response.add("providers", providersArray);

                    String jsonStr = gson.toJson(response);
                    LOG.info("[ProviderHandler] Successfully read " + providers.size() + " provider configs");
                    callJavaScript("import_preview_result", escapeJs(jsonStr));

                } catch (Exception e) {
                    String errorDetails = com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.readFailed") + ": " + e.getMessage();
                    LOG.error("[ProviderHandler] " + errorDetails, e);
                    sendErrorToFrontend(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.readFailedTitle"), errorDetails);
                }
            });
        });
    }

    /**
     * Open file chooser for cc-switch database file
     */
    private void handleOpenFileChooserForCcSwitch() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                FileChooserDescriptor descriptor = new FileChooserDescriptor(
                    true,   // chooseFiles
                    false,  // chooseFolders
                    false,  // chooseJars
                    false,  // chooseJarsAsFiles
                    false,  // chooseJarContents
                    false   // chooseMultiple
                );

                descriptor.setTitle(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.selectTitle"));
                descriptor.setDescription(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.selectDesc"));
                descriptor.withFileFilter(file -> {
                    String name = file.getName().toLowerCase();
                    return name.endsWith(".db");
                });

                // Set default path to .cc-switch under user home directory
                String userHome = System.getProperty("user.home");
                File defaultDir = new File(userHome, ".cc-switch");
                VirtualFile defaultVirtualFile = null;
                if (defaultDir.exists()) {
                    defaultVirtualFile = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
                        .findFileByPath(defaultDir.getAbsolutePath());
                }

                LOG.info("[ProviderHandler] 打开文件选择器，默认目录: " +
                    (defaultVirtualFile != null ? defaultVirtualFile.getPath() : "用户主目录"));

                // Open file chooser
                VirtualFile[] selectedFiles = FileChooser.chooseFiles(
                    descriptor,
                    context.getProject(),
                    defaultVirtualFile
                );

                if (selectedFiles.length == 0) {
                    LOG.info("[ProviderHandler] User cancelled file selection");
                    sendInfoToFrontend(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.cancelledTitle"), com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.cancelled"));
                    return;
                }

                VirtualFile selectedFile = selectedFiles[0];
                String dbPath = selectedFile.getPath();
                File dbFile = new File(dbPath);

                LOG.info("[ProviderHandler] 用户选择的数据库文件路径: " + dbFile.getAbsolutePath());
                LOG.info("[ProviderHandler] 数据库文件是否存在: " + dbFile.exists());

                if (!dbFile.exists()) {
                    String errorMsg = com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.notFound", dbFile.getAbsolutePath());
                    LOG.error("[ProviderHandler] " + errorMsg);
                    sendErrorToFrontend(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.notFoundTitle"), errorMsg);
                    return;
                }

                if (!dbFile.canRead()) {
                    String errorMsg = com.github.claudecodegui.ClaudeCodeGuiBundle.message("error.cannotReadFile") + "\n" +
                                     dbFile.getAbsolutePath() + "\n" +
                                     com.github.claudecodegui.ClaudeCodeGuiBundle.message("error.checkFilePermissions");
                    LOG.error("[ProviderHandler] " + errorMsg);
                    sendErrorToFrontend(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.permissionErrorTitle"), errorMsg);
                    return;
                }

                // Read database asynchronously
                CompletableFuture.runAsync(() -> {
                    try {
                        LOG.info("[ProviderHandler] 开始读取用户选择的数据库文件...");
                        Gson gson = new Gson();
                        List<JsonObject> providers = context.getSettingsService().parseProvidersFromCcSwitchDb(dbFile.getPath());

                        if (providers.isEmpty()) {
                            LOG.info("[ProviderHandler] No Claude provider configs found in database");
                            sendInfoToFrontend(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.noDataTitle"), com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.noData"));
                            return;
                        }

                        JsonArray providersArray = new JsonArray();
                        for (JsonObject p : providers) {
                            providersArray.add(p);
                        }

                        JsonObject response = new JsonObject();
                        response.add("providers", providersArray);

                        String jsonStr = gson.toJson(response);
                        LOG.info("[ProviderHandler] 成功读取 " + providers.size() + " 个供应商配置，准备发送到前端");
                        callJavaScript("import_preview_result", escapeJs(jsonStr));

                    } catch (Exception e) {
                        String errorDetails = com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.readFailed") + ": " + e.getMessage();
                        LOG.error("[ProviderHandler] " + errorDetails, e);
                        sendErrorToFrontend(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.readFailedTitle"), errorDetails);
                    }
                });

            } catch (Exception e) {
                String errorDetails = com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.fileChooserFailed") + ": " + e.getMessage();
                LOG.error("[ProviderHandler] " + errorDetails, e);
                sendErrorToFrontend(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.fileChooserFailedTitle"), errorDetails);
            }
        });
    }

    /**
     * Save imported providers.
     */
    private void handleSaveImportedProviders(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                Gson gson = new Gson();
                JsonObject request = gson.fromJson(content, JsonObject.class);
                JsonArray providersArray = request.getAsJsonArray("providers");

                if (providersArray == null || providersArray.size() == 0) {
                    return;
                }

                List<JsonObject> providers = new ArrayList<>();
                for (JsonElement e : providersArray) {
                    if (e.isJsonObject()) {
                        providers.add(e.getAsJsonObject());
                    }
                }

                int count = context.getSettingsService().saveProviders(providers);

                ApplicationManager.getApplication().invokeLater(() -> {
                    handleGetProviders(); // Refresh UI
                    sendInfoToFrontend(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.importSuccessTitle"), com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.importSuccess", count));
                });

            } catch (Exception e) {
                LOG.error("Failed to save imported providers", e);
                sendErrorToFrontend(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.ccswitch.saveFailedTitle"), e.getMessage());
            }
        });
    }

    /**
     * Send info notification to the frontend.
     */
    private void sendInfoToFrontend(String title, String message) {
        // Use multi-parameter passing to avoid JSON nested parsing issues
        callJavaScript("backend_notification", "info", escapeJs(title), escapeJs(message));
    }

    /**
     * Send error notification to the frontend.
     */
    private void sendErrorToFrontend(String title, String message) {
        // Use multi-parameter passing to avoid JSON nested parsing issues
        callJavaScript("backend_notification", "error", escapeJs(title), escapeJs(message));
    }

    // ==================== Codex Provider Handlers ====================

    /**
     * Get all Codex providers
     */
    private void handleGetCodexProviders() {
        try {
            List<JsonObject> providers = context.getSettingsService().getCodexProviders();
            Gson gson = new Gson();
            String providersJson = gson.toJson(providers);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateCodexProviders", escapeJs(providersJson));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to get Codex providers: " + e.getMessage(), e);
        }
    }

    /**
     * Get current Codex CLI configuration (~/.codex/)
     */
    private void handleGetCurrentCodexConfig() {
        try {
            JsonObject config = context.getSettingsService().getCurrentCodexConfig();
            Gson gson = new Gson();
            String configJson = gson.toJson(config);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateCurrentCodexConfig", escapeJs(configJson));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to get current Codex config: " + e.getMessage(), e);
        }
    }

    /**
     * Add Codex provider
     */
    private void handleAddCodexProvider(String content) {
        try {
            Gson gson = new Gson();
            JsonObject provider = gson.fromJson(content, JsonObject.class);
            context.getSettingsService().addCodexProvider(provider);

            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetCodexProviders(); // Refresh list
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to add Codex provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.addCodexFailed", e.getMessage())));
            });
        }
    }

    /**
     * Update Codex provider
     */
    private void handleUpdateCodexProvider(String content) {
        try {
            Gson gson = new Gson();
            JsonObject data = gson.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();
            JsonObject updates = data.getAsJsonObject("updates");

            context.getSettingsService().updateCodexProvider(id, updates);

            boolean syncedActiveProvider = false;
            JsonObject activeProvider = context.getSettingsService().getActiveCodexProvider();
            if (activeProvider != null &&
                activeProvider.has("id") &&
                id.equals(activeProvider.get("id").getAsString())) {
                context.getSettingsService().applyActiveProviderToCodexSettings();
                syncedActiveProvider = true;
            }

            final boolean finalSynced = syncedActiveProvider;
            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetCodexProviders(); // Refresh list
                if (finalSynced) {
                    handleGetActiveCodexProvider(); // Refresh active provider config
                }
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to update Codex provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.updateCodexFailed", e.getMessage())));
            });
        }
    }

    /**
     * Delete Codex provider
     */
    private void handleDeleteCodexProvider(String content) {
        LOG.debug("[ProviderHandler] ========== handleDeleteCodexProvider START ==========");
        LOG.debug("[ProviderHandler] Received content: " + content);

        try {
            Gson gson = new Gson();
            JsonObject data = gson.fromJson(content, JsonObject.class);
            LOG.debug("[ProviderHandler] Parsed JSON data: " + data);

            if (!data.has("id")) {
                LOG.error("[ProviderHandler] ERROR: Missing 'id' field in request");
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.deleteCodexMissingId")));
                });
                return;
            }

            String id = data.get("id").getAsString();
            LOG.info("[ProviderHandler] Deleting Codex provider with ID: " + id);

            DeleteResult result = context.getSettingsService().deleteCodexProvider(id);
            LOG.debug("[ProviderHandler] Delete result - success: " + result.isSuccess());

            if (result.isSuccess()) {
                LOG.info("[ProviderHandler] Delete successful, refreshing provider list");
                ApplicationManager.getApplication().invokeLater(() -> {
                    handleGetCodexProviders(); // Refresh list
                });
            } else {
                String errorMsg = result.getUserFriendlyMessage();
                LOG.warn("[ProviderHandler] Delete Codex provider failed: " + errorMsg);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs(errorMsg));
                });
            }
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Exception in handleDeleteCodexProvider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.deleteCodexFailed", e.getMessage())));
            });
        }

        LOG.debug("[ProviderHandler] ========== handleDeleteCodexProvider END ==========");
    }

    /**
     * Switch Codex provider
     */
    private void handleSwitchCodexProvider(String content) {
        try {
            Gson gson = new Gson();
            JsonObject data = gson.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();

            context.getSettingsService().switchCodexProvider(id);
            context.getSettingsService().applyActiveProviderToCodexSettings();

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showSwitchSuccess", escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("toast.providerSwitchSuccess") + com.github.claudecodegui.ClaudeCodeGuiBundle.message("provider.switchSyncCodex")));
                handleGetCodexProviders(); // Refresh provider list
                handleGetCurrentCodexConfig(); // Refresh Codex CLI config display
                handleGetActiveCodexProvider(); // Refresh active provider config
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to switch Codex provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("toast.providerSwitchFailed") + ": " + e.getMessage()));
            });
        }
    }

    /**
     * Get currently active Codex provider
     */
    private void handleGetActiveCodexProvider() {
        try {
            JsonObject provider = context.getSettingsService().getActiveCodexProvider();
            Gson gson = new Gson();
            String providerJson = gson.toJson(provider);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateActiveCodexProvider", escapeJs(providerJson));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to get active Codex provider: " + e.getMessage(), e);
        }
    }
}

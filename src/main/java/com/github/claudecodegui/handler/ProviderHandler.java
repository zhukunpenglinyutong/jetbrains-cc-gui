package com.github.claudecodegui.handler;

import com.github.claudecodegui.model.DeleteResult;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.vfs.VirtualFile;

import javax.swing.*;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Provider（供应商）相关消息处理器
 * 处理供应商的增删改查和切换
 */
public class ProviderHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(ProviderHandler.class);

    private static final String[] SUPPORTED_TYPES = {
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
        "save_imported_providers"
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
     * 获取所有供应商
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
     * 获取当前 Claude CLI 配置 (~/.claude/settings.json)
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
     * 添加供应商
     */
    private void handleAddProvider(String content) {
        try {
            Gson gson = new Gson();
            JsonObject provider = gson.fromJson(content, JsonObject.class);
            context.getSettingsService().addClaudeProvider(provider);

            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetProviders(); // 刷新列表
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to add provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("添加供应商失败: " + e.getMessage()));
            });
        }
    }

    /**
     * 更新供应商
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
                handleGetProviders(); // 刷新列表
                if (finalSynced) {
                    handleGetActiveProvider(); // 刷新当前激活的供应商配置
                }
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to update provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("更新供应商失败: " + e.getMessage()));
            });
        }
    }

    /**
     * 删除供应商
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
                    callJavaScript("window.showError", escapeJs("删除失败: 请求中缺少供应商 ID"));
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
                    handleGetProviders(); // 刷新列表
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
                callJavaScript("window.showError", escapeJs("删除供应商失败: " + e.getMessage()));
            });
        }

        LOG.debug("[ProviderHandler] ========== handleDeleteProvider END ==========");
    }

    /**
     * 切换供应商
     */
    private void handleSwitchProvider(String content) {
        try {
            Gson gson = new Gson();
            JsonObject data = gson.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();

            context.getSettingsService().switchClaudeProvider(id);
            context.getSettingsService().applyActiveProviderToClaudeSettings();

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showSwitchSuccess", escapeJs("供应商切换成功！\n\n已自动同步到 ~/.claude/settings.json，下一次提问将使用新的配置。"));
                handleGetProviders(); // 刷新供应商列表
                handleGetCurrentClaudeConfig(); // 刷新 Claude CLI 配置显示
                handleGetActiveProvider(); // 刷新当前激活的供应商配置
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to switch provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("切换供应商失败: " + e.getMessage()));
            });
        }
    }

    /**
     * 获取当前激活的供应商
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
     * 预览 cc-switch 导入
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
                String errorMsg = "未找到 cc-switch 数据库文件\n" +
                                 "路径: " + dbFile.getAbsolutePath() + "\n" +
                                 "您可以主动选择cc-switch.db文件进行导入，或者检查：:\n" +
                                 "1. 已安装 cc-switch 3.8.2 及以上版本\n" +
                                 "2. 至少配置过一个 Claude 供应商";
                LOG.error("[ProviderHandler] " + errorMsg);
                sendErrorToFrontend("文件未找到", errorMsg);
                return;
            }

            CompletableFuture.runAsync(() -> {
                try {
                    LOG.info("[ProviderHandler] 开始读取数据库文件...");
                    Gson gson = new Gson();
                    List<JsonObject> providers = context.getSettingsService().parseProvidersFromCcSwitchDb(dbFile.getPath());

                    if (providers.isEmpty()) {
                        LOG.info("[ProviderHandler] 数据库中没有找到 Claude 供应商配置");
                        sendInfoToFrontend("无数据", "未在数据库中找到有效的 Claude 供应商配置。");
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
                    String errorDetails = "读取数据库失败: " + e.getMessage();
                    LOG.error("[ProviderHandler] " + errorDetails, e);
                    sendErrorToFrontend("读取数据库失败", errorDetails);
                }
            });
        });
    }

    /**
     * 打开文件选择器选择 cc-switch 数据库文件
     */
    private void handleOpenFileChooserForCcSwitch() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                // 创建文件选择器描述符
                FileChooserDescriptor descriptor = new FileChooserDescriptor(
                    true,   // chooseFiles - 允许选择文件
                    false,  // chooseFolders - 不允许选择文件夹
                    false,  // chooseJars - 不允许选择 JAR
                    false,  // chooseJarsAsFiles - 不将 JAR 当作文件
                    false,  // chooseJarContents - 不允许选择 JAR 内容
                    false   // chooseMultiple - 不允许多选
                );

                descriptor.setTitle("选择 cc-switch 数据库文件");
                descriptor.setDescription("请选择 cc-switch.db 或其副本文件");
                descriptor.withFileFilter(file -> {
                    String name = file.getName().toLowerCase();
                    return name.endsWith(".db");
                });

                // 设置默认路径为用户主目录下的 .cc-switch
                String userHome = System.getProperty("user.home");
                File defaultDir = new File(userHome, ".cc-switch");
                VirtualFile defaultVirtualFile = null;
                if (defaultDir.exists()) {
                    defaultVirtualFile = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
                        .findFileByPath(defaultDir.getAbsolutePath());
                }

                LOG.info("[ProviderHandler] 打开文件选择器，默认目录: " +
                    (defaultVirtualFile != null ? defaultVirtualFile.getPath() : "用户主目录"));

                // 打开文件选择器
                VirtualFile[] selectedFiles = FileChooser.chooseFiles(
                    descriptor,
                    context.getProject(),
                    defaultVirtualFile
                );

                if (selectedFiles.length == 0) {
                    LOG.info("[ProviderHandler] 用户取消了文件选择");
                    sendInfoToFrontend("已取消", "未选择文件");
                    return;
                }

                VirtualFile selectedFile = selectedFiles[0];
                String dbPath = selectedFile.getPath();
                File dbFile = new File(dbPath);

                LOG.info("[ProviderHandler] 用户选择的数据库文件路径: " + dbFile.getAbsolutePath());
                LOG.info("[ProviderHandler] 数据库文件是否存在: " + dbFile.exists());

                if (!dbFile.exists()) {
                    String errorMsg = "未找到数据库文件\n" +
                                     "路径: " + dbFile.getAbsolutePath();
                    LOG.error("[ProviderHandler] " + errorMsg);
                    sendErrorToFrontend("文件未找到", errorMsg);
                    return;
                }

                if (!dbFile.canRead()) {
                    String errorMsg = "无法读取文件\n" +
                                     "路径: " + dbFile.getAbsolutePath() + "\n" +
                                     "请检查文件权限";
                    LOG.error("[ProviderHandler] " + errorMsg);
                    sendErrorToFrontend("权限错误", errorMsg);
                    return;
                }

                // 异步读取数据库
                CompletableFuture.runAsync(() -> {
                    try {
                        LOG.info("[ProviderHandler] 开始读取用户选择的数据库文件...");
                        Gson gson = new Gson();
                        List<JsonObject> providers = context.getSettingsService().parseProvidersFromCcSwitchDb(dbFile.getPath());

                        if (providers.isEmpty()) {
                            LOG.info("[ProviderHandler] 数据库中没有找到 Claude 供应商配置");
                            sendInfoToFrontend("无数据", "未在数据库中找到有效的 Claude 供应商配置。");
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
                        String errorDetails = "读取数据库失败: " + e.getMessage();
                        LOG.error("[ProviderHandler] " + errorDetails, e);
                        sendErrorToFrontend("读取数据库失败", errorDetails);
                    }
                });

            } catch (Exception e) {
                String errorDetails = "打开文件选择器失败: " + e.getMessage();
                LOG.error("[ProviderHandler] " + errorDetails, e);
                sendErrorToFrontend("文件选择失败", errorDetails);
            }
        });
    }

    /**
     * 保存导入的供应商
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
                    handleGetProviders(); // 刷新界面
                    sendInfoToFrontend("导入成功", "成功导入 " + count + " 个配置。");
                });

            } catch (Exception e) {
                LOG.error("Failed to save imported providers", e);
                sendErrorToFrontend("保存失败", e.getMessage());
            }
        });
    }

    /**
     * 发送信息通知到前端
     */
    private void sendInfoToFrontend(String title, String message) {
        // 使用多参数传递，避免 JSON 嵌套解析问题
        callJavaScript("backend_notification", "info", escapeJs(title), escapeJs(message));
    }

    /**
     * 发送错误通知到前端
     */
    private void sendErrorToFrontend(String title, String message) {
        // 使用多参数传递，避免 JSON 嵌套解析问题
        callJavaScript("backend_notification", "error", escapeJs(title), escapeJs(message));
    }
}

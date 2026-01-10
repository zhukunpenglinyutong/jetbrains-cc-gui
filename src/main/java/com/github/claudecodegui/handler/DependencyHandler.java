package com.github.claudecodegui.handler;

import com.github.claudecodegui.dependency.DependencyManager;
import com.github.claudecodegui.dependency.InstallResult;
import com.github.claudecodegui.dependency.SdkDefinition;
import com.github.claudecodegui.dependency.UpdateInfo;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.util.concurrent.CompletableFuture;

/**
 * SDK 依赖管理消息处理器
 * 处理前端发来的依赖安装、卸载、检查更新等请求
 */
public class DependencyHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(DependencyHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "get_dependency_status",      // 获取所有 SDK 状态
        "install_dependency",         // 安装 SDK
        "uninstall_dependency",       // 卸载 SDK
        "check_dependency_updates",   // 检查更新
        "check_node_environment"      // 检查 Node.js 环境
    };

    private final DependencyManager dependencyManager;
    private final Gson gson;

    public DependencyHandler(HandlerContext context) {
        super(context);
        this.dependencyManager = new DependencyManager();
        this.gson = new Gson();
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_dependency_status":
                handleGetStatus();
                return true;
            case "install_dependency":
                handleInstall(content);
                return true;
            case "uninstall_dependency":
                handleUninstall(content);
                return true;
            case "check_dependency_updates":
                handleCheckUpdates(content);
                return true;
            case "check_node_environment":
                handleCheckNodeEnvironment();
                return true;
            default:
                return false;
        }
    }

    /**
     * 获取所有 SDK 的安装状态
     */
    private void handleGetStatus() {
        try {
            JsonObject status = dependencyManager.getAllSdkStatus();
            String statusJson = gson.toJson(status);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateDependencyStatus", escapeJs(statusJson));
            });
        } catch (Exception e) {
            LOG.error("[DependencyHandler] Failed to get dependency status: " + e.getMessage(), e);
            sendErrorResult("updateDependencyStatus", e.getMessage());
        }
    }

    /**
     * 安装 SDK
     */
    private void handleInstall(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String sdkId = json.get("id").getAsString();

            SdkDefinition sdk = SdkDefinition.fromId(sdkId);
            if (sdk == null) {
                sendInstallResult(InstallResult.failure(sdkId, "Unknown SDK: " + sdkId, ""));
                return;
            }

            // 检查 Node.js 环境
            if (!dependencyManager.checkNodeEnvironment()) {
                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("success", false);
                errorResult.addProperty("sdkId", sdkId);
                errorResult.addProperty("error", "node_not_configured");
                errorResult.addProperty("message", "Node.js not configured. Please set Node.js path in Settings > Basic.");

                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.dependencyInstallResult", escapeJs(gson.toJson(errorResult)));
                });
                return;
            }

            // 异步安装
            CompletableFuture.runAsync(() -> {
                InstallResult result = dependencyManager.installSdkSync(sdkId, (logLine) -> {
                    // 发送安装进度日志
                    JsonObject progress = new JsonObject();
                    progress.addProperty("sdkId", sdkId);
                    progress.addProperty("log", logLine);

                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.dependencyInstallProgress", escapeJs(gson.toJson(progress)));
                    });
                });

                sendInstallResult(result);

                // 安装完成后刷新状态
                if (result.isSuccess()) {
                    handleGetStatus();
                }
            });

        } catch (Exception e) {
            LOG.error("[DependencyHandler] Failed to install dependency: " + e.getMessage(), e);
            sendErrorResult("dependencyInstallResult", e.getMessage());
        }
    }

    /**
     * 卸载 SDK
     */
    private void handleUninstall(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String sdkId = json.get("id").getAsString();

            CompletableFuture.runAsync(() -> {
                boolean success = dependencyManager.uninstallSdk(sdkId);

                JsonObject result = new JsonObject();
                result.addProperty("success", success);
                result.addProperty("sdkId", sdkId);
                if (!success) {
                    result.addProperty("error", "Failed to uninstall SDK");
                }

                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.dependencyUninstallResult", escapeJs(gson.toJson(result)));
                });

                // 卸载完成后刷新状态
                handleGetStatus();
            });

        } catch (Exception e) {
            LOG.error("[DependencyHandler] Failed to uninstall dependency: " + e.getMessage(), e);
            sendErrorResult("dependencyUninstallResult", e.getMessage());
        }
    }

    /**
     * 检查 SDK 更新
     */
    private void handleCheckUpdates(String content) {
        try {
            String sdkId = null;
            if (content != null && !content.isEmpty()) {
                JsonObject json = gson.fromJson(content, JsonObject.class);
                if (json.has("id")) {
                    sdkId = json.get("id").getAsString();
                }
            }

            final String targetSdkId = sdkId;

            CompletableFuture.runAsync(() -> {
                JsonObject updates = new JsonObject();

                if (targetSdkId != null) {
                    // 检查指定 SDK
                    UpdateInfo info = dependencyManager.checkForUpdates(targetSdkId);
                    updates.add(targetSdkId, toJson(info));
                } else {
                    // 检查所有已安装的 SDK
                    for (SdkDefinition sdk : SdkDefinition.values()) {
                        if (dependencyManager.isInstalled(sdk.getId())) {
                            UpdateInfo info = dependencyManager.checkForUpdates(sdk.getId());
                            updates.add(sdk.getId(), toJson(info));
                        }
                    }
                }

                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.dependencyUpdateAvailable", escapeJs(gson.toJson(updates)));
                });
            });

        } catch (Exception e) {
            LOG.error("[DependencyHandler] Failed to check updates: " + e.getMessage(), e);
            sendErrorResult("dependencyUpdateAvailable", e.getMessage());
        }
    }

    /**
     * 检查 Node.js 环境
     */
    private void handleCheckNodeEnvironment() {
        try {
            boolean available = dependencyManager.checkNodeEnvironment();

            JsonObject result = new JsonObject();
            result.addProperty("available", available);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.nodeEnvironmentStatus", escapeJs(gson.toJson(result)));
            });

        } catch (Exception e) {
            LOG.error("[DependencyHandler] Failed to check Node environment: " + e.getMessage(), e);
            JsonObject result = new JsonObject();
            result.addProperty("available", false);
            result.addProperty("error", e.getMessage());

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.nodeEnvironmentStatus", escapeJs(gson.toJson(result)));
            });
        }
    }

    // ==================== 辅助方法 ====================

    private void sendInstallResult(InstallResult result) {
        JsonObject json = new JsonObject();
        json.addProperty("success", result.isSuccess());
        json.addProperty("sdkId", result.getSdkId());

        if (result.isSuccess()) {
            json.addProperty("installedVersion", result.getInstalledVersion());
        } else {
            json.addProperty("error", result.getErrorMessage());
        }
        json.addProperty("logs", result.getLogs());

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.dependencyInstallResult", escapeJs(gson.toJson(json)));
        });
    }

    private JsonObject toJson(UpdateInfo info) {
        JsonObject json = new JsonObject();
        json.addProperty("sdkId", info.getSdkId());
        json.addProperty("sdkName", info.getSdkName());
        json.addProperty("hasUpdate", info.hasUpdate());
        json.addProperty("currentVersion", info.getCurrentVersion());
        json.addProperty("latestVersion", info.getLatestVersion());

        if (info.getErrorMessage() != null) {
            json.addProperty("error", info.getErrorMessage());
        }

        return json;
    }

    private void sendErrorResult(String callback, String errorMessage) {
        JsonObject error = new JsonObject();
        error.addProperty("success", false);
        error.addProperty("error", errorMessage);

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window." + callback, escapeJs(gson.toJson(error)));
        });
    }
}

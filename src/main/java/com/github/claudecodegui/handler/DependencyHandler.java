package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.dependency.DependencyManager;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.dependency.InstallResult;
import com.github.claudecodegui.dependency.SdkDefinition;
import com.github.claudecodegui.dependency.UpdateInfo;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.concurrent.CompletableFuture;

/**
 * SDK dependency management message handler.
 * Processes dependency install, uninstall, and update check requests from the frontend.
 */
public class DependencyHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(DependencyHandler.class);
    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";

    private static final String[] SUPPORTED_TYPES = {
        "get_dependency_status",      // Get all SDK statuses
        "install_dependency",         // Install SDK
        "uninstall_dependency",       // Uninstall SDK
        "check_dependency_updates",   // Check for updates
        "check_node_environment"      // Check Node.js environment
    };

    private final DependencyManager dependencyManager;
    private final Gson gson;
    private final NodeDetector nodeDetector;
    private volatile boolean lazyInitialized;
    private final Object initLock;

    public DependencyHandler(HandlerContext context) {
        super(context);
        this.nodeDetector = NodeDetector.getInstance();
        this.dependencyManager = new DependencyManager(this.nodeDetector);
        this.gson = new Gson();
        this.lazyInitialized = false;
        this.initLock = new Object();
    }

    /**
     * Get the configured Node.js path from settings.
     */
    private String getConfiguredNodePath() {
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String savedPath = props.getValue(NODE_PATH_PROPERTY_KEY);
            if (savedPath != null && !savedPath.trim().isEmpty()) {
                return savedPath.trim();
            }
        } catch (Exception e) {
            LOG.warn("[DependencyHandler] Failed to get configured Node.js path: " + e.getMessage());
        }
        return null;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        this.ensureInitializedAsync();

        switch (type) {
            case "get_dependency_status":
                this.handleGetStatus();
                return true;
            case "install_dependency":
                this.handleInstall(content);
                return true;
            case "uninstall_dependency":
                this.handleUninstall(content);
                return true;
            case "check_dependency_updates":
                this.handleCheckUpdates(content);
                return true;
            case "check_node_environment":
                this.handleCheckNodeEnvironment();
                return true;
            default:
                return false;
        }
    }

    /**
     * Performs deferred Node.js cache warm-up for configured path.
     */
    private void ensureInitializedAsync() {
        if (this.lazyInitialized) {
            return;
        }

        synchronized (this.initLock) {
            if (this.lazyInitialized) {
                return;
            }
            this.lazyInitialized = true;
        }

        CompletableFuture.runAsync(() -> {
            try {
                String configuredNodePath = this.getConfiguredNodePath();
                if (configuredNodePath == null || configuredNodePath.isEmpty()) {
                    return;
                }

                String version = this.nodeDetector.verifyNodePath(configuredNodePath);
                if (version != null) {
                    this.nodeDetector.setNodeExecutable(configuredNodePath);
                    LOG.info("[DependencyHandler] Using configured Node.js path: " +
                             configuredNodePath + " (" + version + ")");
                } else {
                    LOG.warn("[DependencyHandler] Configured Node.js path is invalid: " + configuredNodePath);
                }
            } catch (Exception e) {
                LOG.warn("[DependencyHandler] Lazy initialization failed: " + e.getMessage(), e);
            }
        }, AppExecutorUtil.getAppExecutorService());
    }

    /**
     * Get installation status of all SDKs.
     */
    private void handleGetStatus() {
        long startTime = System.currentTimeMillis();
        CompletableFuture.runAsync(() -> {
            try {
                JsonObject status = this.dependencyManager.getAllSdkStatus();
                String statusJson = this.gson.toJson(status);

                ApplicationManager.getApplication().invokeLater(() ->
                    this.callJavaScript("window.updateDependencyStatus", this.escapeJs(statusJson))
                );
            } catch (Exception e) {
                LOG.error("[DependencyHandler] Failed to get dependency status: " + e.getMessage(), e);
                this.sendErrorResult("updateDependencyStatus", e.getMessage());
                this.sendShowError("获取依赖状态失败: " + e.getMessage());
            } finally {
                long elapsed = System.currentTimeMillis() - startTime;
                LOG.info("[DependencyHandler] handleGetStatus completed in " + elapsed +
                         "ms on thread " + Thread.currentThread().getName());
            }
        }, AppExecutorUtil.getAppExecutorService());
    }

    /**
     * Install SDK.
     */
    private void handleInstall(String content) {
        try {
            JsonObject json = this.gson.fromJson(content, JsonObject.class);
            String sdkId = json.get("id").getAsString();

            SdkDefinition sdk = SdkDefinition.fromId(sdkId);
            if (sdk == null) {
                this.sendInstallResult(InstallResult.failure(sdkId, "Unknown SDK: " + sdkId, ""));
                return;
            }

            // Move the entire install flow (including Node env check) to background thread
            // to avoid blocking the CEF IO thread if the cache is cold.
            CompletableFuture.runAsync(() -> {
                try {
                    // Check Node.js environment (may involve process I/O on cache miss)
                    if (!this.dependencyManager.checkNodeEnvironment()) {
                        JsonObject errorResult = new JsonObject();
                        errorResult.addProperty("success", false);
                        errorResult.addProperty("sdkId", sdkId);
                        errorResult.addProperty("error", "node_not_configured");
                        errorResult.addProperty(
                            "message",
                            "Node.js not configured. Please set Node.js path in Settings > Basic."
                        );

                        ApplicationManager.getApplication().invokeLater(() ->
                            this.callJavaScript(
                                "window.dependencyInstallResult",
                                this.escapeJs(this.gson.toJson(errorResult))
                            )
                        );
                        return;
                    }

                    InstallResult result = this.dependencyManager.installSdkSync(sdkId, (logLine) -> {
                        // Send installation progress log
                        JsonObject progress = new JsonObject();
                        progress.addProperty("sdkId", sdkId);
                        progress.addProperty("log", logLine);

                        ApplicationManager.getApplication().invokeLater(
                            () -> this.callJavaScript(
                                "window.dependencyInstallProgress",
                                this.escapeJs(this.gson.toJson(progress))
                            )
                        );
                    });

                    this.sendInstallResult(result);

                    // Refresh status after installation completes
                    if (result.isSuccess()) {
                        this.handleGetStatus();
                    }
                } catch (Exception e) {
                    LOG.error("[DependencyHandler] Failed during dependency installation: " + e.getMessage(), e);
                    this.sendErrorResult("dependencyInstallResult", e.getMessage());
                    this.sendShowError("依赖安装失败: " + e.getMessage());
                }
            }, AppExecutorUtil.getAppExecutorService());

        } catch (Exception e) {
            LOG.error("[DependencyHandler] Failed to install dependency: " + e.getMessage(), e);
            this.sendErrorResult("dependencyInstallResult", e.getMessage());
            this.sendShowError("依赖安装失败: " + e.getMessage());
        }
    }

    /**
     * Uninstall SDK.
     */
    private void handleUninstall(String content) {
        try {
            JsonObject json = this.gson.fromJson(content, JsonObject.class);
            String sdkId = json.get("id").getAsString();

            CompletableFuture.runAsync(() -> {
                try {
                    boolean success = this.dependencyManager.uninstallSdk(sdkId);

                    JsonObject result = new JsonObject();
                    result.addProperty("success", success);
                    result.addProperty("sdkId", sdkId);
                    if (!success) {
                        result.addProperty("error", "Failed to uninstall SDK");
                    }

                    ApplicationManager.getApplication().invokeLater(() ->
                        this.callJavaScript("window.dependencyUninstallResult", this.escapeJs(this.gson.toJson(result)))
                    );

                    // Refresh status after uninstall completes
                    this.handleGetStatus();
                } catch (Exception e) {
                    LOG.error("[DependencyHandler] Failed during dependency uninstall: " + e.getMessage(), e);
                    this.sendErrorResult("dependencyUninstallResult", e.getMessage());
                    this.sendShowError("依赖卸载失败: " + e.getMessage());
                }
            }, AppExecutorUtil.getAppExecutorService());

        } catch (Exception e) {
            LOG.error("[DependencyHandler] Failed to uninstall dependency: " + e.getMessage(), e);
            this.sendErrorResult("dependencyUninstallResult", e.getMessage());
            this.sendShowError("依赖卸载失败: " + e.getMessage());
        }
    }

    /**
     * Check for SDK updates.
     */
    private void handleCheckUpdates(String content) {
        try {
            String sdkId = null;
            if (content != null && !content.isEmpty()) {
                JsonObject json = this.gson.fromJson(content, JsonObject.class);
                if (json.has("id")) {
                    sdkId = json.get("id").getAsString();
                }
            }

            final String targetSdkId = sdkId;

            CompletableFuture.runAsync(() -> {
                try {
                    JsonObject updates = new JsonObject();

                    if (targetSdkId != null) {
                        // Check specified SDK
                        UpdateInfo info = this.dependencyManager.checkForUpdates(targetSdkId);
                        updates.add(targetSdkId, this.toJson(info));
                    } else {
                        // Check all installed SDKs
                        for (SdkDefinition sdk : SdkDefinition.values()) {
                            if (this.dependencyManager.isInstalled(sdk.getId())) {
                                UpdateInfo info = this.dependencyManager.checkForUpdates(sdk.getId());
                                updates.add(sdk.getId(), this.toJson(info));
                            }
                        }
                    }

                    ApplicationManager.getApplication().invokeLater(
                        () -> this.callJavaScript(
                            "window.dependencyUpdateAvailable",
                            this.escapeJs(this.gson.toJson(updates))
                        )
                    );
                } catch (Exception e) {
                    LOG.error("[DependencyHandler] Failed during update check: " + e.getMessage(), e);
                    this.sendErrorResult("dependencyUpdateAvailable", e.getMessage());
                    this.sendShowError("检查依赖更新失败: " + e.getMessage());
                }
            }, AppExecutorUtil.getAppExecutorService());

        } catch (Exception e) {
            LOG.error("[DependencyHandler] Failed to check updates: " + e.getMessage(), e);
            this.sendErrorResult("dependencyUpdateAvailable", e.getMessage());
            this.sendShowError("检查依赖更新失败: " + e.getMessage());
        }
    }

    /**
     * Check Node.js environment.
     * Prefers the configured Node.js path; falls back to auto-detection if not configured.
     */
    private void handleCheckNodeEnvironment() {
        long startTime = System.currentTimeMillis();
        CompletableFuture.runAsync(() -> {
            try {
                boolean available = false;
                String detectedPath = null;
                String detectedVersion = null;

                // Fast-path: use cached shared detection result with no process/file I/O.
                String cachedPath = this.nodeDetector.getCachedNodePath();
                String cachedVersion = this.nodeDetector.getCachedNodeVersion();
                if (cachedPath != null && cachedVersion != null) {
                    available = true;
                    detectedPath = cachedPath;
                    detectedVersion = cachedVersion;
                }

                // If cache miss, first check if there is a configured Node.js path.
                if (!available) {
                    String configuredPath = this.getConfiguredNodePath();
                    if (configuredPath != null && !configuredPath.isEmpty()) {
                        NodeDetectionResult verifyResult =
                            this.nodeDetector.verifyAndCacheNodePath(configuredPath);
                        if (verifyResult.isFound()) {
                            available = true;
                            detectedPath = verifyResult.getNodePath();
                            detectedVersion = verifyResult.getNodeVersion();
                            LOG.info("[DependencyHandler] Node.js found at configured path: " +
                                     configuredPath + " (" + detectedVersion + ")");
                        } else {
                            LOG.warn("[DependencyHandler] Configured Node.js path is invalid: " + configuredPath);
                        }
                    }
                }

                // If the configured path is invalid, try auto-detection
                if (!available) {
                    available = this.dependencyManager.checkNodeEnvironment();
                    if (available) {
                        detectedPath = this.nodeDetector.getCachedNodePath();
                        detectedVersion = this.nodeDetector.getCachedNodeVersion();
                    }
                }

                JsonObject result = new JsonObject();
                result.addProperty("available", available);
                if (detectedPath != null) {
                    result.addProperty("path", detectedPath);
                }
                if (detectedVersion != null) {
                    result.addProperty("version", detectedVersion);
                }

                this.sendNodeEnvironmentStatus(result);
            } catch (Exception e) {
                LOG.error("[DependencyHandler] Failed to check Node environment: " + e.getMessage(), e);
                JsonObject result = new JsonObject();
                result.addProperty("available", false);
                result.addProperty("error", e.getMessage());
                this.sendNodeEnvironmentStatus(result);
                this.sendShowError("检查 Node.js 环境失败: " + e.getMessage());
            } finally {
                long elapsed = System.currentTimeMillis() - startTime;
                LOG.info("[DependencyHandler] handleCheckNodeEnvironment completed in " + elapsed +
                         "ms on thread " + Thread.currentThread().getName());
            }
        }, AppExecutorUtil.getAppExecutorService());
    }

    // ==================== Helper Methods ====================

    private void sendNodeEnvironmentStatus(JsonObject result) {
        ApplicationManager.getApplication().invokeLater(() ->
            this.callJavaScript("window.nodeEnvironmentStatus", this.escapeJs(this.gson.toJson(result)))
        );
    }

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

        ApplicationManager.getApplication().invokeLater(() ->
            this.callJavaScript("window.dependencyInstallResult", this.escapeJs(this.gson.toJson(json)))
        );
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

    private void sendShowError(String message) {
        ApplicationManager.getApplication().invokeLater(() ->
            this.callJavaScript("window.showError", this.escapeJs(message))
        );
    }

    private void sendErrorResult(String callback, String errorMessage) {
        JsonObject error = new JsonObject();
        error.addProperty("success", false);
        error.addProperty("error", errorMessage);

        ApplicationManager.getApplication().invokeLater(() ->
            this.callJavaScript("window." + callback, this.escapeJs(this.gson.toJson(error)))
        );
    }
}

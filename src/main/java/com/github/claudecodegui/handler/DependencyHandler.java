package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.dependency.DependencyManager;
import com.github.claudecodegui.dependency.InstallResult;
import com.github.claudecodegui.dependency.SdkDefinition;
import com.github.claudecodegui.dependency.UpdateInfo;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

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

    public DependencyHandler(HandlerContext context) {
        super(context);
        // Create NodeDetector and try using the configured Node.js path
        NodeDetector nodeDetector = new NodeDetector();
        String configuredNodePath = getConfiguredNodePath();
        if (configuredNodePath != null && !configuredNodePath.isEmpty()) {
            String version = nodeDetector.verifyNodePath(configuredNodePath);
            if (version != null) {
                nodeDetector.setNodeExecutable(configuredNodePath);
                LOG.info("[DependencyHandler] Using configured Node.js path: " + configuredNodePath + " (" + version + ")");
            } else {
                LOG.warn("[DependencyHandler] Configured Node.js path is invalid: " + configuredNodePath);
            }
        }
        this.dependencyManager = new DependencyManager(nodeDetector);
        this.gson = new Gson();
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
     * Get installation status of all SDKs.
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
     * Install SDK.
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

            // Check Node.js environment
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

            // Asynchronous installation
            CompletableFuture.runAsync(() -> {
                InstallResult result = dependencyManager.installSdkSync(sdkId, (logLine) -> {
                    // Send installation progress log
                    JsonObject progress = new JsonObject();
                    progress.addProperty("sdkId", sdkId);
                    progress.addProperty("log", logLine);

                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.dependencyInstallProgress", escapeJs(gson.toJson(progress)));
                    });
                });

                sendInstallResult(result);

                // Refresh status after installation completes
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
     * Uninstall SDK.
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

                // Refresh status after uninstall completes
                handleGetStatus();
            });

        } catch (Exception e) {
            LOG.error("[DependencyHandler] Failed to uninstall dependency: " + e.getMessage(), e);
            sendErrorResult("dependencyUninstallResult", e.getMessage());
        }
    }

    /**
     * Check for SDK updates.
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
                    // Check specified SDK
                    UpdateInfo info = dependencyManager.checkForUpdates(targetSdkId);
                    updates.add(targetSdkId, toJson(info));
                } else {
                    // Check all installed SDKs
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
     * Check Node.js environment.
     * Prefers the configured Node.js path; falls back to auto-detection if not configured.
     */
    private void handleCheckNodeEnvironment() {
        try {
            // First check if there is a configured Node.js path
            String configuredPath = getConfiguredNodePath();
            boolean available = false;
            String detectedPath = null;
            String detectedVersion = null;

            if (configuredPath != null && !configuredPath.isEmpty()) {
                // Use configured path
                NodeDetector nodeDetector = new NodeDetector();
                String version = nodeDetector.verifyNodePath(configuredPath);
                if (version != null) {
                    available = true;
                    detectedPath = configuredPath;
                    detectedVersion = version;
                    LOG.info("[DependencyHandler] Node.js found at configured path: " + configuredPath + " (" + version + ")");
                } else {
                    LOG.warn("[DependencyHandler] Configured Node.js path is invalid: " + configuredPath);
                }
            }

            // If the configured path is invalid, try auto-detection
            if (!available) {
                available = dependencyManager.checkNodeEnvironment();
            }

            JsonObject result = new JsonObject();
            result.addProperty("available", available);
            if (detectedPath != null) {
                result.addProperty("path", detectedPath);
            }
            if (detectedVersion != null) {
                result.addProperty("version", detectedVersion);
            }

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

    // ==================== Helper Methods ====================

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

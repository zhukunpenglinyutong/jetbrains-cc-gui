package com.github.claudecodegui.handler;

import com.github.claudecodegui.startup.BridgePreloader;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import javax.swing.*;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * MCP server management message handler.
 */
public class McpServerHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(McpServerHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "get_mcp_servers",
        "get_mcp_server_status",
        "get_mcp_server_tools",
        "add_mcp_server",
        "update_mcp_server",
        "delete_mcp_server",
        "toggle_mcp_server",
        "validate_mcp_server"
    };

    public McpServerHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_mcp_servers":
                handleGetMcpServers();
                return true;
            case "get_mcp_server_status":
                handleGetMcpServerStatus();
                return true;
            case "get_mcp_server_tools":
                handleGetMcpServerTools(content);
                return true;
            case "add_mcp_server":
                handleAddMcpServer(content);
                return true;
            case "update_mcp_server":
                handleUpdateMcpServer(content);
                return true;
            case "delete_mcp_server":
                handleDeleteMcpServer(content);
                return true;
            case "toggle_mcp_server":
                handleToggleMcpServer(content);
                return true;
            case "validate_mcp_server":
                handleValidateMcpServer(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Get all MCP servers.
     */
    private void handleGetMcpServers() {
        try {
            // Get project path for reading project-level MCP configuration
            String projectPath = context.getProject() != null
                ? context.getProject().getBasePath()
                : null;

            List<JsonObject> servers = context.getSettingsService().getMcpServersWithProjectPath(projectPath);
            Gson gson = new Gson();
            String serversJson = gson.toJson(servers);

            LOG.info("[McpServerHandler] Loaded " + servers.size() + " MCP servers for project: "
                + (projectPath != null ? projectPath : "(no project)"));

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateMcpServers", escapeJs(serversJson));
            });
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to get MCP servers: " + e.getMessage(), e);
        }
    }

    /**
     * Get MCP server connection status.
     * Retrieves real-time MCP server connection status via Claude SDK.
     */
    private void handleGetMcpServerStatus() {
        try {
            String cwd = context.getProject() != null
                ? context.getProject().getBasePath()
                : null;

            // Wait for bridge to be ready first (prevents issues when bridge is still extracting on first load)
            waitForBridgeAndFetchStatus(cwd);
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to get MCP server status: " + e.getMessage(), e);
        }
    }

    /**
     * Wait for bridge readiness then fetch server status.
     * Solves the issue where bridge not being ready on first load returns empty list.
     */
    private void waitForBridgeAndFetchStatus(String cwd) {
        CompletableFuture.runAsync(() -> {
            try {
                // If bridge not ready, wait up to 10 seconds
                if (!BridgePreloader.isBridgeReady()) {
                    LOG.info("[McpServerHandler] Bridge not ready yet, waiting...");
                    boolean ready = BridgePreloader.waitForBridgeAsync()
                        .get(10, TimeUnit.SECONDS);
                    if (ready) {
                        LOG.info("[McpServerHandler] Bridge is now ready, fetching status");
                    } else {
                        LOG.warn("[McpServerHandler] Bridge still not ready after timeout, proceeding anyway");
                    }
                }

                // Get server status
                context.getClaudeSDKBridge().getMcpServerStatus(cwd)
                    .thenAccept(statusList -> {
                        Gson gson = new Gson();
                        String statusJson = gson.toJson(statusList);

                        // Add debug logging to help troubleshoot name matching issues
                        LOG.info("[McpServerHandler] MCP server status received: " + statusList.size() + " servers");
                        for (JsonObject status : statusList) {
                            if (status.has("name")) {
                                String serverName = status.get("name").getAsString();
                                String serverStatus = status.has("status") ? status.get("status").getAsString() : "unknown";
                                LOG.info("[McpServerHandler] Server: " + serverName + ", Status: " + serverStatus);
                            }
                        }

                        ApplicationManager.getApplication().invokeLater(() -> {
                            callJavaScript("window.updateMcpServerStatus", escapeJs(statusJson));
                        });
                    })
                    .exceptionally(e -> {
                        LOG.error("[McpServerHandler] Failed to get MCP server status: "
                            + e.getMessage(), e);
                        ApplicationManager.getApplication().invokeLater(() -> {
                            callJavaScript("window.updateMcpServerStatus", escapeJs("[]"));
                        });
                        return null;
                    });
            } catch (Exception e) {
                LOG.error("[McpServerHandler] Error while waiting for bridge or fetching status: "
                    + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.updateMcpServerStatus", escapeJs("[]"));
                });
            }
        });
    }

    /**
     * Get tool list for a specified MCP server.
     * Retrieves tool list by calling the ai-bridge mcp-status-service.
     */
    private void handleGetMcpServerTools(String content) {
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String serverId = json.get("serverId").getAsString();

            LOG.info("[McpServerHandler] Getting tools for server: " + serverId);

            // Wait for bridge to be ready before fetching tool list
            waitForBridgeAndFetchTools(serverId, gson);
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to get MCP server tools: " + e.getMessage(), e);
        }
    }

    /**
     * Wait for bridge readiness then fetch server tool list.
     * Prevents tool fetching failure when bridge is not ready on first load.
     */
    private void waitForBridgeAndFetchTools(String serverId, Gson gson) {
        CompletableFuture.runAsync(() -> {
            try {
                // If bridge not ready, wait up to 10 seconds
                if (!BridgePreloader.isBridgeReady()) {
                    LOG.info("[McpServerHandler] Bridge not ready yet for tools, waiting...");
                    boolean ready = BridgePreloader.waitForBridgeAsync()
                        .get(10, TimeUnit.SECONDS);
                    if (ready) {
                        LOG.info("[McpServerHandler] Bridge is now ready, fetching tools");
                    } else {
                        LOG.warn("[McpServerHandler] Bridge still not ready after timeout, proceeding anyway");
                    }
                }

                // Call Claude SDK Bridge to get tool list
                context.getClaudeSDKBridge().getMcpServerTools(serverId)
                    .thenAccept(result -> {
                        String resultJson = gson.toJson(result);
                        LOG.info("[McpServerHandler] Got tools result: " + resultJson);
                        ApplicationManager.getApplication().invokeLater(() -> {
                            callJavaScript("window.updateMcpServerTools", escapeJs(resultJson));
                        });
                    })
                    .exceptionally(e -> {
                        LOG.error("[McpServerHandler] Failed to get MCP server tools: "
                            + e.getMessage(), e);
                        ApplicationManager.getApplication().invokeLater(() -> {
                            JsonObject errorResult = new JsonObject();
                            errorResult.addProperty("serverId", serverId);
                            errorResult.addProperty("error", e.getMessage());
                            errorResult.add("tools", new com.google.gson.JsonArray());
                            callJavaScript("window.updateMcpServerTools", escapeJs(gson.toJson(errorResult)));
                        });
                        return null;
                    });
            } catch (Exception e) {
                LOG.error("[McpServerHandler] Error while waiting for bridge or fetching tools: "
                    + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    JsonObject errorResult = new JsonObject();
                    errorResult.addProperty("serverId", serverId);
                    errorResult.addProperty("error", e.getMessage());
                    errorResult.add("tools", new com.google.gson.JsonArray());
                    callJavaScript("window.updateMcpServerTools", escapeJs(gson.toJson(errorResult)));
                });
            }
        });
    }

    /**
     * Add an MCP server.
     */
    private void handleAddMcpServer(String content) {
        try {
            Gson gson = new Gson();
            JsonObject server = gson.fromJson(content, JsonObject.class);

            context.getSettingsService().upsertMcpServer(server);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.mcpServerAdded", escapeJs(content));
                handleGetMcpServers();
            });
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to add MCP server: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                String errorMsg = escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("mcp.addServerFailedWithReason", e.getMessage()));
                callJavaScript("window.showError", errorMsg);
            });
        }
    }

    /**
     * Update an MCP server.
     */
    private void handleUpdateMcpServer(String content) {
        try {
            Gson gson = new Gson();
            JsonObject server = gson.fromJson(content, JsonObject.class);

            context.getSettingsService().upsertMcpServer(server);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.mcpServerUpdated", escapeJs(content));
                handleGetMcpServers();
            });
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to update MCP server: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                String errorMsg = escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("mcp.updateServerFailedWithReason", e.getMessage()));
                callJavaScript("window.showError", errorMsg);
            });
        }
    }

    /**
     * Delete an MCP server.
     */
    private void handleDeleteMcpServer(String content) {
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String serverId = json.get("id").getAsString();

            boolean success = context.getSettingsService().deleteMcpServer(serverId);

            if (success) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.mcpServerDeleted", escapeJs(serverId));
                    handleGetMcpServers();
                });
            } else {
                ApplicationManager.getApplication().invokeLater(() -> {
                    String errorMsg = escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("mcp.deleteServerFailedWithReason", com.github.claudecodegui.ClaudeCodeGuiBundle.message("mcp.serverNotFound")));
                    callJavaScript("window.showError", errorMsg);
                });
            }
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to delete MCP server: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                String errorMsg = escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("mcp.deleteServerFailedWithReason", e.getMessage()));
                callJavaScript("window.showError", errorMsg);
            });
        }
    }

    /**
     * Toggle MCP server enabled/disabled state.
     */
    private void handleToggleMcpServer(String content) {
        try {
            Gson gson = new Gson();
            JsonObject server = gson.fromJson(content, JsonObject.class);

            // Update server configuration
            String projectPath = context.getProject() != null
                ? context.getProject().getBasePath()
                : null;
            context.getSettingsService().upsertMcpServer(server, projectPath);

            boolean isEnabled = !server.has("enabled") || server.get("enabled").getAsBoolean();
            String serverId = server.get("id").getAsString();
            String serverName = server.has("name") ? server.get("name").getAsString() : serverId;

            LOG.info("[McpServerHandler] Toggled MCP server: " + serverName + " (enabled: " + isEnabled + ")");

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.mcpServerToggled", escapeJs(content));
                handleGetMcpServers();
                // Also refresh status so the UI shows the latest connection state
                handleGetMcpServerStatus();
            });
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to toggle MCP server: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("切换 MCP 服务器状态失败: " + e.getMessage()));
            });
        }
    }

    /**
     * Validate MCP server configuration.
     */
    private void handleValidateMcpServer(String content) {
        try {
            Gson gson = new Gson();
            JsonObject server = gson.fromJson(content, JsonObject.class);

            Map<String, Object> validation = context.getSettingsService().validateMcpServer(server);
            String validationJson = gson.toJson(validation);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.mcpServerValidated", escapeJs(validationJson));
            });
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to validate MCP server: " + e.getMessage(), e);
        }
    }
}

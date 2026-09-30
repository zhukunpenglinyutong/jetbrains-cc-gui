package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.settings.McpServerManager;
import com.github.claudecodegui.startup.BridgePreloader;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import javax.swing.*;
import java.util.ArrayList;
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
        "validate_mcp_server",
        "approve_mcp_json_server",
        "reject_mcp_json_server"
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
                handleGetMcpServerStatus(content);
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
            case "approve_mcp_json_server":
                handleApproveMcpJsonServer(content);
                return true;
            case "reject_mcp_json_server":
                handleRejectMcpJsonServer(content);
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
            // Send empty array so frontend exits loading state instead of hanging
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateMcpServers", escapeJs("[]"));
            });
        }
    }

    /**
     * Get MCP server connection status.
     * Retrieves real-time MCP server connection status via Claude SDK.
     *
     * <p>The optional {@code serverNames} array in the payload restricts the check to the named
     * servers. The response is then delivered to a separate JS callback so the webview can merge
     * it into the existing status map instead of replacing every entry.
     */
    private void handleGetMcpServerStatus(String content) {
        try {
            String cwd = context.getProject() != null
                ? context.getProject().getBasePath()
                : null;

            // Wait for bridge to be ready first (prevents issues when bridge is still extracting on first load)
            waitForBridgeAndFetchStatus(cwd, parseServerNames(content));
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to get MCP server status: " + e.getMessage(), e);
        }
    }

    /**
     * Read the optional serverNames array from a request payload.
     * Returns null when absent, malformed, or empty — meaning "check every server".
     */
    private static List<String> parseServerNames(String content) {
        if (content == null || content.isEmpty()) {
            return null;
        }
        try {
            JsonObject json = new Gson().fromJson(content, JsonObject.class);
            if (json == null || !json.has("serverNames") || !json.get("serverNames").isJsonArray()) {
                return null;
            }
            List<String> names = new ArrayList<>();
            for (JsonElement element : json.getAsJsonArray("serverNames")) {
                if (element.isJsonPrimitive() && !element.getAsString().isEmpty()) {
                    names.add(element.getAsString());
                }
            }
            return names.isEmpty() ? null : names;
        } catch (Exception e) {
            // A malformed filter must not break the request — fall back to a full check.
            LOG.warn("[McpServerHandler] Ignoring malformed serverNames filter: " + e.getMessage());
            return null;
        }
    }

    /**
     * Wait for bridge readiness then fetch server status.
     * Solves the issue where bridge not being ready on first load returns empty list.
     */
    private void waitForBridgeAndFetchStatus(String cwd, List<String> serverNames) {
        boolean isPartial = serverNames != null && !serverNames.isEmpty();
        // A full response replaces the webview's status map; a partial one only merges into it.
        // Getting this wrong on the error paths would wipe every server's status.
        String statusCallback = isPartial
            ? "window.updateMcpServerStatusPartial"
            : "window.updateMcpServerStatus";
        // A partial response is authoritative for the servers it asked about: a rejected
        // project .mcp.json server is dropped from the config entirely and therefore
        // comes back with no entry at all. Handing the names to the webview lets it
        // drop that server's stale status instead of leaving a green "connected" dot.
        // Passed on the error paths too, so a failed check cannot leave a stale badge.
        String requestedNamesJson = escapeJs(new Gson().toJson(
            isPartial ? serverNames : new ArrayList<String>()));
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
                context.getClaudeSDKBridge().getMcpServerStatus(cwd, serverNames)
                    .thenAccept(statusList -> {
                        Gson gson = new Gson();
                        String statusJson = gson.toJson(statusList);

                        // Add debug logging to help troubleshoot name matching issues
                        LOG.info("[McpServerHandler] MCP server status received: " + statusList.size() + " servers"
                            + (isPartial ? " (partial: " + serverNames + ")" : ""));
                        for (JsonObject status : statusList) {
                            if (status.has("name")) {
                                String serverName = status.get("name").getAsString();
                                String serverStatus = status.has("status") ? status.get("status").getAsString() : "unknown";
                                LOG.info("[McpServerHandler] Server: " + serverName + ", Status: " + serverStatus);
                            }
                        }

                        ApplicationManager.getApplication().invokeLater(() -> {
                            callJavaScript(statusCallback, escapeJs(statusJson), requestedNamesJson);
                        });
                    })
                    .exceptionally(e -> {
                        LOG.error("[McpServerHandler] Failed to get MCP server status: "
                            + e.getMessage(), e);
                        ApplicationManager.getApplication().invokeLater(() -> {
                            callJavaScript(statusCallback, escapeJs("[]"), requestedNamesJson);
                        });
                        return null;
                    });
            } catch (Exception e) {
                LOG.error("[McpServerHandler] Error while waiting for bridge or fetching status: "
                    + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript(statusCallback, escapeJs("[]"), requestedNamesJson);
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

            String cwd = context.getProject() != null
                ? context.getProject().getBasePath()
                : null;

            // Wait for bridge to be ready before fetching tool list
            waitForBridgeAndFetchTools(serverId, cwd, gson);
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to get MCP server tools: " + e.getMessage(), e);
        }
    }

    /**
     * Wait for bridge readiness then fetch server tool list.
     * Prevents tool fetching failure when bridge is not ready on first load.
     */
    private void waitForBridgeAndFetchTools(String serverId, String cwd, Gson gson) {
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
                context.getClaudeSDKBridge().getMcpServerTools(serverId, cwd)
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
                String errorMsg = escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("mcp.addServerFailedWithReason", e.getMessage()));
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
            String projectPath = context.getProject() != null
                ? context.getProject().getBasePath()
                : null;

            context.getSettingsService().upsertMcpServer(server, projectPath);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.mcpServerUpdated", escapeJs(content));
                handleGetMcpServers();
            });
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to update MCP server: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                String errorMsg = escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("mcp.updateServerFailedWithReason", e.getMessage()));
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
            String projectPath = context.getProject() != null
                ? context.getProject().getBasePath()
                : null;

            boolean success = context.getSettingsService().deleteMcpServer(serverId, projectPath);

            if (success) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.mcpServerDeleted", escapeJs(serverId));
                    handleGetMcpServers();
                });
            } else {
                ApplicationManager.getApplication().invokeLater(() -> {
                    String reason = com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("mcp.serverNotFound");
                    String errorMsg = escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message(
                            "mcp.deleteServerFailedWithReason", reason));
                    callJavaScript("window.showError", errorMsg);
                });
            }
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to delete MCP server: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                String errorMsg = escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("mcp.deleteServerFailedWithReason", e.getMessage()));
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
                // Also refresh status so the UI shows the latest connection state.
                // Full check on purpose: toggling changes the effective config, and this
                // path is not part of the targeted approve/reject flow.
                handleGetMcpServerStatus(null);
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

    /**
     * Approve a project-scoped .mcp.json server.
     * Persists the approval (together with a sha256 fingerprint of the approved
     * spec) to the project's .claude/settings.local.json and refreshes the server
     * list so the UI reflects the new approval state.
     */
    private void handleApproveMcpJsonServer(String content) {
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String serverId = json.has("serverId") ? json.get("serverId").getAsString() : null;

            if (serverId == null || serverId.isEmpty()) {
                LOG.warn("[McpServerHandler] approve_mcp_json_server: missing serverId");
                showError(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("mcp.serverIdRequired"));
                return;
            }

            String projectPath = context.getProject() != null
                ? context.getProject().getBasePath()
                : null;

            if (projectPath == null || projectPath.isEmpty()) {
                LOG.warn("[McpServerHandler] approve_mcp_json_server: project path is null or empty");
                showError(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("mcp.projectPathRequired"));
                return;
            }

            // The id arrives from the webview, so it is not trusted until it has been
            // length/character-checked and matched against a real .mcp.json entry.
            String invalid = McpServerManager.validateProjectMcpServerId(serverId, projectPath);
            if (invalid != null) {
                LOG.warn("[McpServerHandler] approve_mcp_json_server: rejected serverId — " + invalid);
                showError(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message(
                    "mcp.approveServerFailedWithReason", invalid));
                return;
            }

            context.getSettingsService().approveProjectMcpJsonServer(serverId, projectPath);

            LOG.info("[McpServerHandler] Approved project MCP server: " + serverId);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.mcpServerApproved", escapeJs(serverId));
                handleGetMcpServers();
            });
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to approve MCP JSON server: " + e.getMessage(), e);
            showError(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message(
                "mcp.approveServerFailedWithReason", e.getMessage()));
        }
    }

    /**
     * Reject a project-scoped .mcp.json server.
     * Persists the rejection to the project's .claude/settings.local.json and
     * refreshes the server list so the UI reflects the new rejection state.
     */
    private void handleRejectMcpJsonServer(String content) {
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String serverId = json.has("serverId") ? json.get("serverId").getAsString() : null;

            if (serverId == null || serverId.isEmpty()) {
                LOG.warn("[McpServerHandler] reject_mcp_json_server: missing serverId");
                showError(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("mcp.serverIdRequired"));
                return;
            }

            String projectPath = context.getProject() != null
                ? context.getProject().getBasePath()
                : null;

            if (projectPath == null || projectPath.isEmpty()) {
                LOG.warn("[McpServerHandler] reject_mcp_json_server: project path is null or empty");
                showError(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("mcp.projectPathRequired"));
                return;
            }

            String invalid = McpServerManager.validateProjectMcpServerId(serverId, projectPath);
            if (invalid != null) {
                LOG.warn("[McpServerHandler] reject_mcp_json_server: rejected serverId — " + invalid);
                showError(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message(
                    "mcp.rejectServerFailedWithReason", invalid));
                return;
            }

            context.getSettingsService().rejectProjectMcpJsonServer(serverId, projectPath);

            LOG.info("[McpServerHandler] Rejected project MCP server: " + serverId);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.mcpServerRejected", escapeJs(serverId));
                handleGetMcpServers();
            });
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to reject MCP JSON server: " + e.getMessage(), e);
            showError(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message(
                "mcp.rejectServerFailedWithReason", e.getMessage()));
        }
    }

    /** Report a message to the webview through the existing error channel. */
    private void showError(String message) {
        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.showError", escapeJs(message));
        });
    }
}

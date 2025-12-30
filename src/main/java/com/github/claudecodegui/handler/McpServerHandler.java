package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import javax.swing.*;
import java.util.List;
import java.util.Map;

/**
 * MCP 服务器管理消息处理器
 */
public class McpServerHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(McpServerHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "get_mcp_servers",
        "get_mcp_server_status",
        "add_mcp_server",
        "update_mcp_server",
        "delete_mcp_server",
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
            case "add_mcp_server":
                handleAddMcpServer(content);
                return true;
            case "update_mcp_server":
                handleUpdateMcpServer(content);
                return true;
            case "delete_mcp_server":
                handleDeleteMcpServer(content);
                return true;
            case "validate_mcp_server":
                handleValidateMcpServer(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * 获取所有 MCP 服务器
     */
    private void handleGetMcpServers() {
        try {
            List<JsonObject> servers = context.getSettingsService().getMcpServers();
            Gson gson = new Gson();
            String serversJson = gson.toJson(servers);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateMcpServers", escapeJs(serversJson));
            });
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to get MCP servers: " + e.getMessage(), e);
        }
    }

    /**
     * 获取 MCP 服务器连接状态.
     * 通过 Claude SDK 获取实时的 MCP 服务器连接状态
     */
    private void handleGetMcpServerStatus() {
        try {
            String cwd = context.getProject() != null
                ? context.getProject().getBasePath()
                : null;

            context.getClaudeSDKBridge().getMcpServerStatus(cwd)
                .thenAccept(statusList -> {
                    Gson gson = new Gson();
                    String statusJson = gson.toJson(statusList);

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
            LOG.error("[McpServerHandler] Failed to get MCP server status: " + e.getMessage(), e);
        }
    }

    /**
     * 添加 MCP 服务器
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
                callJavaScript("window.showError", escapeJs("添加 MCP 服务器失败: " + e.getMessage()));
            });
        }
    }

    /**
     * 更新 MCP 服务器
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
                callJavaScript("window.showError", escapeJs("更新 MCP 服务器失败: " + e.getMessage()));
            });
        }
    }

    /**
     * 删除 MCP 服务器
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
                    callJavaScript("window.showError", escapeJs("删除 MCP 服务器失败: 服务器不存在"));
                });
            }
        } catch (Exception e) {
            LOG.error("[McpServerHandler] Failed to delete MCP server: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("删除 MCP 服务器失败: " + e.getMessage()));
            });
        }
    }

    /**
     * 验证 MCP 服务器配置
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

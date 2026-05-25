package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.concurrent.CompletableFuture;

/**
 * Read-only MCP server listing for opencode.
 *
 * opencode owns its MCP configuration and connection lifecycle. This handler
 * only mirrors the current /mcp status into the shared settings UI.
 */
public class OpenCodeMcpServerHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(OpenCodeMcpServerHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "get_opencode_mcp_servers",
        "get_opencode_mcp_server_status",
        "get_opencode_mcp_server_tools"
    };

    private final Object queryLock = new Object();
    private CompletableFuture<JsonObject> inFlightQuery;
    private String inFlightCwd;

    public OpenCodeMcpServerHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_opencode_mcp_servers":
                handleGetMcpServers();
                return true;
            case "get_opencode_mcp_server_status":
                handleGetMcpServerStatus();
                return true;
            case "get_opencode_mcp_server_tools":
                handleGetMcpServerTools(content);
                return true;
            default:
                return false;
        }
    }

    private void handleGetMcpServers() {
        try {
            if (!isOpenCodeLocalConfigAuthorized()) {
                sendServerList(new JsonArray());
                return;
            }

            CompletableFuture.supplyAsync(
                    () -> context.getOpenCodeSDKBridge().listMcpServers(getProjectPath()),
                    AppExecutorUtil.getAppExecutorService()
                )
                .thenAccept(result -> {
                    JsonArray servers = getArrayResult(result, "servers");
                    LOG.info("[OpenCodeMcpServerHandler] Loaded " + servers.size() + " opencode MCP servers");
                    sendServerList(servers);
                })
                .exceptionally(e -> {
                    LOG.warn("[OpenCodeMcpServerHandler] Failed to get opencode MCP servers: " + e.getMessage(), e);
                    sendServerList(new JsonArray());
                    return null;
                });
        } catch (Exception e) {
            LOG.warn("[OpenCodeMcpServerHandler] Failed to get opencode MCP servers: " + e.getMessage(), e);
            sendServerList(new JsonArray());
        }
    }

    private void handleGetMcpServerStatus() {
        try {
            if (!isOpenCodeLocalConfigAuthorized()) {
                sendServerStatus(new JsonArray());
                return;
            }

            queryMcpServerStatus(getProjectPath())
                .thenAccept(result -> {
                    JsonArray status = getArrayResult(result, "status");
                    LOG.info("[OpenCodeMcpServerHandler] Loaded status for " + status.size() + " opencode MCP servers");
                    sendServerStatus(status);
                })
                .exceptionally(e -> {
                    LOG.warn("[OpenCodeMcpServerHandler] Failed to get opencode MCP server status: " + e.getMessage(), e);
                    sendServerStatus(new JsonArray());
                    return null;
                });
        } catch (Exception e) {
            LOG.warn("[OpenCodeMcpServerHandler] Failed to get opencode MCP server status: " + e.getMessage(), e);
            sendServerStatus(new JsonArray());
        }
    }

    private void handleGetMcpServerTools(String content) {
        Gson gson = new Gson();
        String serverId = "";
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            if (json != null && json.has("serverId") && !json.get("serverId").isJsonNull()) {
                serverId = json.get("serverId").getAsString();
            }
        } catch (Exception ignored) {
        }

        JsonObject result = new JsonObject();
        result.addProperty("serverId", serverId);
        result.addProperty("error", "opencode MCP tool listing is not available through the current /mcp endpoint");
        result.add("tools", new JsonArray());
        String json = gson.toJson(result);
        ApplicationManager.getApplication().invokeLater(() ->
            callJavaScript("window.updateMcpServerTools", escapeJs(json))
        );
    }

    private CompletableFuture<JsonObject> queryMcpServerStatus(String cwd) {
        synchronized (queryLock) {
            if (inFlightQuery != null && !inFlightQuery.isDone() && sameCwd(inFlightCwd, cwd)) {
                return inFlightQuery;
            }

            inFlightCwd = cwd;
            inFlightQuery = CompletableFuture.supplyAsync(
                () -> context.getOpenCodeSDKBridge().listMcpServerStatus(cwd),
                AppExecutorUtil.getAppExecutorService()
            );
            inFlightQuery.whenComplete((ignored, error) -> {
                synchronized (queryLock) {
                    if (sameCwd(inFlightCwd, cwd)) {
                        inFlightQuery = null;
                        inFlightCwd = null;
                    }
                }
            });
            return inFlightQuery;
        }
    }

    private boolean sameCwd(String left, String right) {
        return left == null ? right == null : left.equals(right);
    }

    private JsonArray getArrayResult(JsonObject result, String key) {
        if (result == null || !result.has("success") || !result.get("success").getAsBoolean()) {
            String error = result != null && result.has("error") && !result.get("error").isJsonNull()
                ? result.get("error").getAsString()
                : "Unknown opencode MCP listing error";
            LOG.warn("[OpenCodeMcpServerHandler] opencode MCP query failed: " + error);
            return new JsonArray();
        }
        if (result.has(key) && result.get(key).isJsonArray()) {
            return result.getAsJsonArray(key);
        }
        return new JsonArray();
    }

    private boolean isOpenCodeLocalConfigAuthorized() {
        try {
            return context.getSettingsService().isOpenCodeLocalConfigAuthorized();
        } catch (Exception e) {
            LOG.warn("[OpenCodeMcpServerHandler] Failed to read opencode authorization state: " + e.getMessage());
            return false;
        }
    }

    private String getProjectPath() {
        return context.getProject() != null ? context.getProject().getBasePath() : null;
    }

    private void sendServerList(JsonArray servers) {
        String json = new Gson().toJson(servers);
        ApplicationManager.getApplication().invokeLater(() ->
            callJavaScript("window.updateOpenCodeMcpServers", escapeJs(json))
        );
    }

    private void sendServerStatus(JsonArray status) {
        String json = new Gson().toJson(status);
        ApplicationManager.getApplication().invokeLater(() ->
            callJavaScript("window.updateOpenCodeMcpServerStatus", escapeJs(json))
        );
    }
}

package com.github.claudecodegui.settings;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.SystemInfo;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.*;

/**
 * Codex MCP Server Manager
 * Manages MCP server configurations in ~/.codex/config.toml
 *
 * Configuration format in config.toml:
 * [mcp_servers.server_name]
 * command = "npx"
 * args = ["-y", "mcp-server"]
 * env = { "API_KEY" = "value" }
 * enabled = true
 * startup_timeout_sec = 20
 * tool_timeout_sec = 60
 */
public class CodexMcpServerManager {
    private static final Logger LOG = Logger.getInstance(CodexMcpServerManager.class);
    private static final int STATUS_CHECK_TIMEOUT_MS = 5000; // 5 seconds timeout for HTTP checks

    private final CodexSettingsManager settingsManager;

    public CodexMcpServerManager(CodexSettingsManager settingsManager) {
        this.settingsManager = settingsManager;
    }

    /**
     * Get all MCP servers from config.toml
     * Reads [mcp_servers.*] sections
     */
    public List<JsonObject> getMcpServers() throws IOException {
        List<JsonObject> result = new ArrayList<>();

        Map<String, Object> config = settingsManager.readConfigToml();
        if (config == null) {
            LOG.info("[CodexMcpServerManager] No config.toml found, returning empty list");
            return result;
        }

        // Look for mcp_servers section
        Object mcpServersObj = config.get("mcp_servers");
        if (!(mcpServersObj instanceof Map)) {
            LOG.info("[CodexMcpServerManager] No mcp_servers section found in config.toml");
            return result;
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> mcpServers = (Map<String, Object>) mcpServersObj;

        for (Map.Entry<String, Object> entry : mcpServers.entrySet()) {
            String serverId = entry.getKey();
            Object serverConfigObj = entry.getValue();

            if (!(serverConfigObj instanceof Map)) {
                continue;
            }

            @SuppressWarnings("unchecked")
            Map<String, Object> serverConfig = (Map<String, Object>) serverConfigObj;

            JsonObject server = convertToJsonObject(serverId, serverConfig);
            result.add(server);
        }

        LOG.info("[CodexMcpServerManager] Loaded " + result.size() + " MCP servers from config.toml");
        return result;
    }

    /**
     * Convert internal map format to JsonObject for frontend
     */
    private JsonObject convertToJsonObject(String serverId, Map<String, Object> serverConfig) {
        JsonObject server = new JsonObject();
        server.addProperty("id", serverId);
        server.addProperty("name", serverId);

        // Build server spec
        JsonObject serverSpec = new JsonObject();

        // Determine type based on presence of command or url
        String type = "stdio";
        if (serverConfig.containsKey("url")) {
            type = "http";
        }
        serverSpec.addProperty("type", type);

        // STDIO fields
        if (serverConfig.containsKey("command")) {
            serverSpec.addProperty("command", String.valueOf(serverConfig.get("command")));
        }
        if (serverConfig.containsKey("args")) {
            serverSpec.add("args", toJsonArray(serverConfig.get("args")));
        }
        if (serverConfig.containsKey("env")) {
            serverSpec.add("env", toJsonObject(serverConfig.get("env")));
        }
        if (serverConfig.containsKey("cwd")) {
            serverSpec.addProperty("cwd", String.valueOf(serverConfig.get("cwd")));
        }
        if (serverConfig.containsKey("env_vars")) {
            serverSpec.add("env_vars", toJsonArray(serverConfig.get("env_vars")));
        }

        // HTTP fields
        if (serverConfig.containsKey("url")) {
            serverSpec.addProperty("url", String.valueOf(serverConfig.get("url")));
        }
        if (serverConfig.containsKey("bearer_token_env_var")) {
            serverSpec.addProperty("bearer_token_env_var", String.valueOf(serverConfig.get("bearer_token_env_var")));
        }
        if (serverConfig.containsKey("http_headers")) {
            serverSpec.add("http_headers", toJsonObject(serverConfig.get("http_headers")));
        }
        if (serverConfig.containsKey("env_http_headers")) {
            serverSpec.add("env_http_headers", toJsonObject(serverConfig.get("env_http_headers")));
        }

        server.add("server", serverSpec);

        // Common optional fields
        boolean enabled = true;
        if (serverConfig.containsKey("enabled")) {
            Object enabledVal = serverConfig.get("enabled");
            enabled = enabledVal instanceof Boolean ? (Boolean) enabledVal : Boolean.parseBoolean(String.valueOf(enabledVal));
        }
        server.addProperty("enabled", enabled);

        if (serverConfig.containsKey("startup_timeout_sec")) {
            server.addProperty("startup_timeout_sec", toNumber(serverConfig.get("startup_timeout_sec")));
        }
        if (serverConfig.containsKey("tool_timeout_sec")) {
            server.addProperty("tool_timeout_sec", toNumber(serverConfig.get("tool_timeout_sec")));
        }
        if (serverConfig.containsKey("enabled_tools")) {
            server.add("enabled_tools", toJsonArray(serverConfig.get("enabled_tools")));
        }
        if (serverConfig.containsKey("disabled_tools")) {
            server.add("disabled_tools", toJsonArray(serverConfig.get("disabled_tools")));
        }

        // Mark as codex server
        JsonObject apps = new JsonObject();
        apps.addProperty("claude", false);
        apps.addProperty("codex", true);
        apps.addProperty("gemini", false);
        server.add("apps", apps);

        return server;
    }

    /**
     * Upsert (add or update) an MCP server
     */
    public void upsertMcpServer(JsonObject server) throws IOException {
        if (!server.has("id")) {
            throw new IllegalArgumentException("Server must have an id");
        }

        String serverId = server.get("id").getAsString();

        // Read current config
        Map<String, Object> config = settingsManager.readConfigToml();
        if (config == null) {
            config = new LinkedHashMap<>();
        }

        // Ensure mcp_servers section exists
        @SuppressWarnings("unchecked")
        Map<String, Object> mcpServers = (Map<String, Object>) config.computeIfAbsent("mcp_servers",
                k -> new LinkedHashMap<String, Object>());

        // Build server config map from JsonObject
        Map<String, Object> serverConfig = buildServerConfigMap(server);

        // Add or update server
        mcpServers.put(serverId, serverConfig);

        // Write back
        settingsManager.writeConfigToml(config);
        LOG.info("[CodexMcpServerManager] Upserted MCP server: " + serverId);
    }

    /**
     * Build config map from JsonObject for TOML writing
     */
    private Map<String, Object> buildServerConfigMap(JsonObject server) {
        Map<String, Object> config = new LinkedHashMap<>();

        // Extract server spec
        JsonObject serverSpec = null;
        if (server.has("server") && server.get("server").isJsonObject()) {
            serverSpec = server.getAsJsonObject("server");
        }

        if (serverSpec != null) {
            // STDIO fields
            if (serverSpec.has("command")) {
                config.put("command", serverSpec.get("command").getAsString());
            }
            if (serverSpec.has("args") && serverSpec.get("args").isJsonArray()) {
                config.put("args", jsonArrayToList(serverSpec.getAsJsonArray("args")));
            }
            if (serverSpec.has("env") && serverSpec.get("env").isJsonObject()) {
                config.put("env", jsonObjectToMap(serverSpec.getAsJsonObject("env")));
            }
            if (serverSpec.has("cwd")) {
                config.put("cwd", serverSpec.get("cwd").getAsString());
            }
            if (serverSpec.has("env_vars") && serverSpec.get("env_vars").isJsonArray()) {
                config.put("env_vars", jsonArrayToList(serverSpec.getAsJsonArray("env_vars")));
            }

            // HTTP fields
            if (serverSpec.has("url")) {
                config.put("url", serverSpec.get("url").getAsString());
            }
            if (serverSpec.has("bearer_token_env_var")) {
                config.put("bearer_token_env_var", serverSpec.get("bearer_token_env_var").getAsString());
            }
            if (serverSpec.has("http_headers") && serverSpec.get("http_headers").isJsonObject()) {
                config.put("http_headers", jsonObjectToMap(serverSpec.getAsJsonObject("http_headers")));
            }
            if (serverSpec.has("env_http_headers") && serverSpec.get("env_http_headers").isJsonObject()) {
                config.put("env_http_headers", jsonObjectToMap(serverSpec.getAsJsonObject("env_http_headers")));
            }
        }

        // Enabled field
        if (server.has("enabled")) {
            config.put("enabled", server.get("enabled").getAsBoolean());
        }

        // Timeout fields
        if (server.has("startup_timeout_sec")) {
            config.put("startup_timeout_sec", server.get("startup_timeout_sec").getAsLong());
        }
        if (server.has("tool_timeout_sec")) {
            config.put("tool_timeout_sec", server.get("tool_timeout_sec").getAsLong());
        }

        // Tool filtering
        if (server.has("enabled_tools") && server.get("enabled_tools").isJsonArray()) {
            config.put("enabled_tools", jsonArrayToList(server.getAsJsonArray("enabled_tools")));
        }
        if (server.has("disabled_tools") && server.get("disabled_tools").isJsonArray()) {
            config.put("disabled_tools", jsonArrayToList(server.getAsJsonArray("disabled_tools")));
        }

        return config;
    }

    /**
     * Delete an MCP server by ID
     */
    public boolean deleteMcpServer(String serverId) throws IOException {
        Map<String, Object> config = settingsManager.readConfigToml();
        if (config == null) {
            return false;
        }

        Object mcpServersObj = config.get("mcp_servers");
        if (!(mcpServersObj instanceof Map)) {
            return false;
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> mcpServers = (Map<String, Object>) mcpServersObj;

        if (!mcpServers.containsKey(serverId)) {
            return false;
        }

        mcpServers.remove(serverId);

        // Write back
        settingsManager.writeConfigToml(config);
        LOG.info("[CodexMcpServerManager] Deleted MCP server: " + serverId);
        return true;
    }

    /**
     * Validate MCP server configuration
     */
    public Map<String, Object> validateMcpServer(JsonObject server) {
        List<String> errors = new ArrayList<>();

        if (!server.has("id") || server.get("id").getAsString().isEmpty()) {
            errors.add("Server ID cannot be empty");
        }

        if (server.has("server")) {
            JsonObject serverSpec = server.getAsJsonObject("server");
            String type = serverSpec.has("type") ? serverSpec.get("type").getAsString() : "stdio";

            if ("stdio".equals(type)) {
                if (!serverSpec.has("command") || serverSpec.get("command").getAsString().isEmpty()) {
                    errors.add("Command cannot be empty for STDIO type");
                }
            } else if ("http".equals(type) || "sse".equals(type)) {
                if (!serverSpec.has("url") || serverSpec.get("url").getAsString().isEmpty()) {
                    errors.add("URL cannot be empty for HTTP/SSE type");
                } else {
                    String url = serverSpec.get("url").getAsString();
                    try {
                        new URI(url).toURL();
                    } catch (Exception e) {
                        errors.add("Invalid URL format");
                    }
                }
            }
        } else {
            errors.add("Missing server configuration");
        }

        Map<String, Object> result = new HashMap<>();
        result.put("valid", errors.isEmpty());
        result.put("errors", errors);
        return result;
    }

    // ==================== Helper Methods ====================

    private JsonArray toJsonArray(Object obj) {
        JsonArray array = new JsonArray();
        if (obj instanceof List) {
            @SuppressWarnings("unchecked")
            List<Object> list = (List<Object>) obj;
            for (Object item : list) {
                if (item instanceof String) {
                    array.add((String) item);
                } else if (item instanceof Number) {
                    array.add((Number) item);
                } else if (item instanceof Boolean) {
                    array.add((Boolean) item);
                } else if (item != null) {
                    array.add(String.valueOf(item));
                }
            }
        }
        return array;
    }

    private JsonObject toJsonObject(Object obj) {
        JsonObject result = new JsonObject();
        if (obj instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) obj;
            for (Map.Entry<String, Object> entry : map.entrySet()) {
                Object value = entry.getValue();
                if (value instanceof String) {
                    result.addProperty(entry.getKey(), (String) value);
                } else if (value instanceof Number) {
                    result.addProperty(entry.getKey(), (Number) value);
                } else if (value instanceof Boolean) {
                    result.addProperty(entry.getKey(), (Boolean) value);
                } else if (value != null) {
                    result.addProperty(entry.getKey(), String.valueOf(value));
                }
            }
        }
        return result;
    }

    private Number toNumber(Object obj) {
        if (obj instanceof Number) {
            return (Number) obj;
        }
        try {
            return Long.parseLong(String.valueOf(obj));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private List<Object> jsonArrayToList(JsonArray array) {
        List<Object> list = new ArrayList<>();
        for (JsonElement elem : array) {
            if (elem.isJsonPrimitive()) {
                if (elem.getAsJsonPrimitive().isString()) {
                    list.add(elem.getAsString());
                } else if (elem.getAsJsonPrimitive().isNumber()) {
                    list.add(elem.getAsNumber());
                } else if (elem.getAsJsonPrimitive().isBoolean()) {
                    list.add(elem.getAsBoolean());
                }
            }
        }
        return list;
    }

    private Map<String, Object> jsonObjectToMap(JsonObject obj) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> entry : obj.entrySet()) {
            JsonElement elem = entry.getValue();
            if (elem.isJsonPrimitive()) {
                if (elem.getAsJsonPrimitive().isString()) {
                    map.put(entry.getKey(), elem.getAsString());
                } else if (elem.getAsJsonPrimitive().isNumber()) {
                    map.put(entry.getKey(), elem.getAsNumber());
                } else if (elem.getAsJsonPrimitive().isBoolean()) {
                    map.put(entry.getKey(), elem.getAsBoolean());
                }
            }
        }
        return map;
    }

    /**
     * Get status of all configured MCP servers
     * Returns a list of status information for each server
     */
    public List<JsonObject> getMcpServerStatus() {
        List<JsonObject> statusList = new ArrayList<>();

        try {
            List<JsonObject> servers = getMcpServers();

            for (JsonObject server : servers) {
                JsonObject status = checkServerStatus(server);
                statusList.add(status);
            }

            LOG.info("[CodexMcpServerManager] Checked status of " + statusList.size() + " MCP servers");
        } catch (Exception e) {
            LOG.error("[CodexMcpServerManager] Failed to get MCP server status: " + e.getMessage(), e);
        }

        return statusList;
    }

    /**
     * Check the status of a single MCP server
     */
    private JsonObject checkServerStatus(JsonObject server) {
        JsonObject status = new JsonObject();
        String serverId = server.has("id") ? server.get("id").getAsString() : "unknown";
        String serverName = server.has("name") ? server.get("name").getAsString() : serverId;

        status.addProperty("name", serverName);

        // Check if server is enabled
        boolean enabled = !server.has("enabled") || server.get("enabled").getAsBoolean();
        if (!enabled) {
            status.addProperty("status", "disabled");
            return status;
        }

        // Get server configuration
        if (!server.has("server") || !server.get("server").isJsonObject()) {
            status.addProperty("status", "failed");
            return status;
        }

        JsonObject serverConfig = server.getAsJsonObject("server");
        String type = serverConfig.has("type") ? serverConfig.get("type").getAsString() : "stdio";

        try {
            if ("http".equals(type) || "sse".equals(type)) {
                // HTTP/SSE server: try to connect
                status.addProperty("status", checkHttpServer(serverConfig, serverName));
            } else {
                // STDIO server: check if command exists
                status.addProperty("status", checkStdioServer(serverConfig, serverName));
            }

            // Add server info if available
            if ("connected".equals(status.get("status").getAsString())) {
                JsonObject serverInfo = new JsonObject();
                serverInfo.addProperty("name", serverName);
                serverInfo.addProperty("version", "unknown");
                status.add("serverInfo", serverInfo);
            }
        } catch (Exception e) {
            LOG.warn("[CodexMcpServerManager] Failed to check server " + serverName + ": " + e.getMessage());
            status.addProperty("status", "failed");
        }

        return status;
    }

    /**
     * Check HTTP/SSE MCP server status by attempting to connect
     */
    private String checkHttpServer(JsonObject serverConfig, String serverName) {
        if (!serverConfig.has("url")) {
            return "failed";
        }

        String url = serverConfig.get("url").getAsString();

        try {
            HttpClient client = HttpClient.newBuilder()
                .connectTimeout(java.time.Duration.ofMillis(STATUS_CHECK_TIMEOUT_MS))
                .build();

            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(java.time.Duration.ofMillis(STATUS_CHECK_TIMEOUT_MS))
                .GET()
                .build();

            HttpResponse<String> response = client.send(request,
                HttpResponse.BodyHandlers.ofString());

            // If we get any response, consider the server reachable
            if (response.statusCode() >= 200 && response.statusCode() < 500) {
                return "connected";
            } else {
                return "failed";
            }
        } catch (Exception e) {
            LOG.info("[CodexMcpServerManager] HTTP server " + serverName + " not reachable: " + e.getMessage());
            return "failed";
        }
    }

    /**
     * Check STDIO MCP server status by verifying command exists
     */
    private String checkStdioServer(JsonObject serverConfig, String serverName) {
        if (!serverConfig.has("command")) {
            return "failed";
        }

        String command = serverConfig.get("command").getAsString();

        // Check if command exists on system PATH
        boolean commandExists = checkCommandExists(command);

        if (commandExists) {
            // For STDIO servers, we can't really test if they start without actually starting them
            // So we return "pending" to indicate configuration looks good but not actually tested
            return "pending";
        } else {
            return "failed";
        }
    }

    /**
     * Check if a command exists on the system PATH
     */
    private boolean checkCommandExists(String command) {
        // Handle commands with arguments (e.g., "npx" - take only first part)
        String commandName = command.split("\\s+")[0];

        // Check for common commands that we know exist
        if (isCommonCommand(commandName)) {
            return true;
        }

        // Try to find the command on PATH
        ProcessBuilder pb = new ProcessBuilder();
        if (SystemInfo.isWindows) {
            pb.command("where", commandName);
        } else {
            pb.command("which", commandName);
        }

        try {
            Process process = pb.start();
            int exitCode = process.waitFor();
            return exitCode == 0;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Check if this is a commonly available command
     */
    private boolean isCommonCommand(String command) {
        // Common package managers
        if ("npm".equals(command) || "npx".equals(command) ||
            "yarn".equals(command) || "pnpx".equals(command) ||
            "pnpm".equals(command)) {
            return true;
        }

        // Common shell commands
        if ("node".equals(command) || "python".equals(command) ||
            "python3".equals(command) || "java".equals(command)) {
            return true;
        }

        // Common on Windows
        if (SystemInfo.isWindows) {
            if ("cmd".equals(command) || "powershell".equals(command) ||
                "pwsh".equals(command)) {
                return true;
            }
        }

        // Common on Unix
        if (!SystemInfo.isWindows) {
            if ("sh".equals(command) || "bash".equals(command) ||
                "zsh".equals(command)) {
                return true;
            }
        }

        return false;
    }
}

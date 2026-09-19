package com.github.claudecodegui.settings;

import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * MCP Server Manager.
 * Manages MCP server configurations.
 */
public class McpServerManager {
    private static final Logger LOG = Logger.getInstance(McpServerManager.class);

    private final Gson gson;
    private final Function<Void, JsonObject> configReader;
    private final java.util.function.Consumer<JsonObject> configWriter;
    private final ClaudeSettingsManager claudeSettingsManager;

    public McpServerManager(
            Gson gson,
            Function<Void, JsonObject> configReader,
            java.util.function.Consumer<JsonObject> configWriter,
            ClaudeSettingsManager claudeSettingsManager) {
        this.gson = gson;
        this.configReader = configReader;
        this.configWriter = configWriter;
        this.claudeSettingsManager = claudeSettingsManager;
    }

    /**
     * Get all MCP servers.
     * Reads from ~/.claude.json first (the standard Claude CLI location),
     * falling back to ~/.codemoss/config.json.
     * <p>
     * Note: Claude CLI merges global and project-level disabledMcpServers.
     */
    public List<JsonObject> getMcpServers() throws IOException {
        return getMcpServersWithProjectPath(null);
    }

    /**
     * Get all MCP servers (with project path support).
     * Merges global and project-level mcpServers; project-level servers override global ones with the same name.
     * Also reads project-level .mcp.json from the project root and marks those servers with source="project".
     *
     * @param projectPath the project path, used to read project-level MCP configuration
     */
    public List<JsonObject> getMcpServersWithProjectPath(String projectPath) throws IOException {
        List<JsonObject> result = new ArrayList<>();

        // 1. Try to read from ~/.claude.json (standard Claude CLI location)
        try {
            String homeDir = NodeDetector.resolveHomeForFileOps();
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (claudeJsonFile.exists()) {
                try (FileReader reader = new FileReader(claudeJsonFile, StandardCharsets.UTF_8)) {
                    JsonObject claudeJson = JsonParser.parseReader(reader).getAsJsonObject();

                    if (claudeJson.has("mcpServers") && claudeJson.get("mcpServers").isJsonObject()) {
                        JsonObject globalMcpServers = claudeJson.getAsJsonObject("mcpServers");

                        // Merge global and project mcpServers (project config overrides servers with the same name)
                        JsonObject mergedServers = new JsonObject();
                        for (String key : globalMcpServers.keySet()) {
                            mergedServers.add(key, globalMcpServers.get(key));
                        }

                        if (projectPath != null && claudeJson.has("projects")) {
                            JsonObject projects = claudeJson.getAsJsonObject("projects");
                            if (projects.has(projectPath)) {
                                JsonObject projectConfig = projects.getAsJsonObject(projectPath);
                                if (projectConfig.has("mcpServers")
                                            && projectConfig.get("mcpServers").isJsonObject()) {
                                    JsonObject projectMcpServers = projectConfig.getAsJsonObject("mcpServers");
                                    for (String key : projectMcpServers.keySet()) {
                                        mergedServers.add(key, projectMcpServers.get(key));
                                    }
                                    LOG.info("[McpServerManager] Merged project-level MCP servers from: " + projectPath);
                                }
                            }
                        }

                        // Read the globally disabled servers list
                        Set<String> disabledServers = new HashSet<>();
                        if (claudeJson.has("disabledMcpServers") && claudeJson.get("disabledMcpServers").isJsonArray()) {
                            JsonArray disabledArray = claudeJson.getAsJsonArray("disabledMcpServers");
                            for (JsonElement elem : disabledArray) {
                                if (elem.isJsonPrimitive()) {
                                    disabledServers.add(elem.getAsString());
                                }
                            }
                        }

                        // Read project-level disabled servers list (if project path is provided)
                        if (projectPath != null && claudeJson.has("projects")) {
                            JsonObject projects = claudeJson.getAsJsonObject("projects");
                            if (projects.has(projectPath)) {
                                JsonObject projectConfig = projects.getAsJsonObject(projectPath);
                                if (projectConfig.has("disabledMcpServers")
                                            && projectConfig.get("disabledMcpServers").isJsonArray()) {
                                    JsonArray projectDisabledArray = projectConfig.getAsJsonArray("disabledMcpServers");
                                    for (JsonElement elem : projectDisabledArray) {
                                        if (elem.isJsonPrimitive()) {
                                            disabledServers.add(elem.getAsString());
                                        }
                                    }
                                    LOG.info("[McpServerManager] Merged project-level disabled servers from: " + projectPath);
                                }
                            }
                        }

                        // Convert merged servers to list format
                        for (String serverId : mergedServers.keySet()) {
                            JsonElement serverElem = mergedServers.get(serverId);
                            if (serverElem.isJsonObject()) {
                                JsonObject server = serverElem.getAsJsonObject();

                                // Ensure id and name fields exist
                                if (!server.has("id")) {
                                    server.addProperty("id", serverId);
                                }
                                if (!server.has("name")) {
                                    server.addProperty("name", serverId);
                                }

                                // Wrap type, command, args, env, etc. into the server field
                                if (!server.has("server")) {
                                    JsonObject serverSpec = new JsonObject();

                                    // Copy all fields to the server spec (except special fields)
                                    Set<String> excludedFields = new HashSet<>();
                                    excludedFields.add("id");
                                    excludedFields.add("name");
                                    excludedFields.add("enabled");
                                    excludedFields.add("apps");
                                    excludedFields.add("server");

                                    for (String key : server.keySet()) {
                                        if (!excludedFields.contains(key)) {
                                            serverSpec.add(key, server.get(key));
                                        }
                                    }

                                    server.add("server", serverSpec);
                                }

                                // Set enabled/disabled status (merging global and project levels)
                                boolean isEnabled = !disabledServers.contains(serverId);
                                server.addProperty("enabled", isEnabled);

                                result.add(server);
                            }
                        }

                        // 1b. Merge project-level .mcp.json servers from project root (if projectPath provided)
                        if (projectPath != null) {
                            List<JsonObject> projectJsonServers = loadProjectMcpJson(projectPath);
                            if (!projectJsonServers.isEmpty()) {
                                for (JsonObject server : projectJsonServers) {
                                    result.add(server);
                                }
                                LOG.info("[McpServerManager] Merged " + projectJsonServers.size()
                                         + " MCP servers from .mcp.json at " + projectPath);
                            }
                        }

                        LOG.info("[McpServerManager] Loaded " + result.size()
                                         + " MCP servers from ~/.claude.json (disabled: " + disabledServers.size() + ")");
                        return result;
                    }
                } catch (Exception e) {
                    LOG.warn("[McpServerManager] Failed to read ~/.claude.json: " + e.getMessage());
                }
            }
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Error accessing ~/.claude.json: " + e.getMessage());
        }

        // If we get here but have a projectPath, still try .mcp.json
        if (projectPath != null) {
            List<JsonObject> projectJsonServers = loadProjectMcpJson(projectPath);
            if (!projectJsonServers.isEmpty()) {
                result.addAll(projectJsonServers);
                LOG.info("[McpServerManager] Loaded " + projectJsonServers.size()
                         + " MCP servers from .mcp.json at " + projectPath);
            }
        }
        JsonObject config = configReader.apply(null);
        if (config.has("mcpServers")) {
            JsonArray servers = config.getAsJsonArray("mcpServers");
            for (JsonElement elem : servers) {
                if (elem.isJsonObject()) {
                    result.add(elem.getAsJsonObject());
                }
            }
        }

        LOG.info("[McpServerManager] Loaded " + result.size() + " MCP servers from ~/.codemoss/config.json");
        return result;
    }

    /**
     * Upsert (update or insert) an MCP server.
     * Prefers updating ~/.claude.json (standard Claude CLI location),
     * falling back to ~/.codemoss/config.json.
     */
    public void upsertMcpServer(JsonObject server) throws IOException {
        upsertMcpServer(server, null);
    }

    /**
     * Upsert (update or insert) an MCP server (with project path support).
     *
     * @param projectPath the project path, used to update project-level disabledMcpServers (Claude CLI merges global and project-level disabled lists)
     */
    public void upsertMcpServer(JsonObject server, String projectPath) throws IOException {
        if (!server.has("id")) {
            throw new IllegalArgumentException("Server must have an id");
        }

        String serverId = server.get("id").getAsString();
        boolean isEnabled = !server.has("enabled") || server.get("enabled").getAsBoolean();

        // 0. If this is a project-local server, update .mcp.json
        boolean isProjectLocal = server.has("source")
            && "project".equals(server.get("source").getAsString());
        if (isProjectLocal && projectPath != null && !projectPath.isEmpty()) {
            if (upsertInProjectMcpJson(server, serverId, isEnabled, projectPath)) {
                LOG.info("[McpServerManager] Upserted MCP server in .mcp.json at " + projectPath + ": " + serverId);
                return;
            }
        }

        // 1. Try to update ~/.claude.json
        try {
            String homeDir = NodeDetector.resolveHomeForFileOps();
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (claudeJsonFile.exists()) {
                try (FileReader reader = new FileReader(claudeJsonFile, StandardCharsets.UTF_8)) {
                    JsonObject claudeJson = JsonParser.parseReader(reader).getAsJsonObject();

                    // Ensure mcpServers object exists
                    if (!claudeJson.has("mcpServers") || !claudeJson.get("mcpServers").isJsonObject()) {
                        claudeJson.add("mcpServers", new JsonObject());
                    }
                    JsonObject mcpServers = claudeJson.getAsJsonObject("mcpServers");

                    // Extract server spec
                    JsonObject serverSpec;
                    if (server.has("server") && server.get("server").isJsonObject()) {
                        serverSpec = server.getAsJsonObject("server").deepCopy();
                    } else {
                        serverSpec = new JsonObject();
                    }

                    // If the server already exists, merge with existing config (preserve fields not specified in new config)
                    if (mcpServers.has(serverId) && mcpServers.get(serverId).isJsonObject()) {
                        JsonObject existingSpec = mcpServers.getAsJsonObject(serverId).deepCopy();
                        // Merge new config onto existing config (new values override matching fields)
                        for (String key : serverSpec.keySet()) {
                            existingSpec.add(key, serverSpec.get(key));
                        }
                        serverSpec = existingSpec;
                    }

                    // Update or add the server
                    mcpServers.add(serverId, serverSpec);

                    // Update the disabledMcpServers list
                    if (!claudeJson.has("disabledMcpServers") || !claudeJson.get("disabledMcpServers").isJsonArray()) {
                        claudeJson.add("disabledMcpServers", new JsonArray());
                    }
                    JsonArray disabledArray = claudeJson.getAsJsonArray("disabledMcpServers");

                    if (projectPath == null) {
                        JsonArray newDisabled = new JsonArray();
                        for (JsonElement elem : disabledArray) {
                            if (!elem.getAsString().equals(serverId)) {
                                newDisabled.add(elem);
                            }
                        }
                        if (!isEnabled) {
                            newDisabled.add(serverId);
                        }
                        claudeJson.add("disabledMcpServers", newDisabled);
                    } else if (isEnabled) {
                        JsonArray newDisabled = new JsonArray();
                        for (JsonElement elem : disabledArray) {
                            if (!elem.getAsString().equals(serverId)) {
                                newDisabled.add(elem);
                            }
                        }
                        claudeJson.add("disabledMcpServers", newDisabled);
                    }

                    if (projectPath != null) {
                        if (!claudeJson.has("projects") || !claudeJson.get("projects").isJsonObject()) {
                            claudeJson.add("projects", new JsonObject());
                        }
                        JsonObject projects = claudeJson.getAsJsonObject("projects");
                        if (!projects.has(projectPath) || !projects.get(projectPath).isJsonObject()) {
                            projects.add(projectPath, new JsonObject());
                        }
                        JsonObject projectConfig = projects.getAsJsonObject(projectPath);
                        if (!projectConfig.has("disabledMcpServers") || !projectConfig.get("disabledMcpServers").isJsonArray()) {
                            projectConfig.add("disabledMcpServers", new JsonArray());
                        }
                        JsonArray projectDisabledArray = projectConfig.getAsJsonArray("disabledMcpServers");

                        JsonArray newProjectDisabled = new JsonArray();
                        for (JsonElement elem : projectDisabledArray) {
                            if (!elem.getAsString().equals(serverId)) {
                                newProjectDisabled.add(elem);
                            }
                        }
                        if (!isEnabled) {
                            newProjectDisabled.add(serverId);
                        }
                        projectConfig.add("disabledMcpServers", newProjectDisabled);
                    }

                    // Write back to file
                    try (FileWriter writer = new FileWriter(claudeJsonFile, StandardCharsets.UTF_8)) {
                        gson.toJson(claudeJson, writer);
                        writer.flush();  // Ensure data is fully flushed to disk
                    }

                    LOG.info("[McpServerManager] Upserted MCP server in ~/.claude.json: " + serverId
                                     + " (enabled: " + isEnabled + ", projectPath: " + (projectPath != null ? projectPath : "(global)") + ")");

                    // Sync to settings.json (after file write is complete)
                    try {
                        claudeSettingsManager.syncMcpToClaudeSettings();
                    } catch (Exception syncError) {
                        LOG.warn("[McpServerManager] Failed to sync MCP to settings.json: " + syncError.getMessage());
                        // Sync failure should not affect the main operation
                    }

                    return;
                }
            }
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Error updating ~/.claude.json: " + e.getMessage());
        }

        // 2. Fall back to ~/.codemoss/config.json
        JsonObject config = configReader.apply(null);
        JsonArray servers;

        if (config.has("mcpServers")) {
            servers = config.getAsJsonArray("mcpServers");
        } else {
            servers = new JsonArray();
            config.add("mcpServers", servers);
        }

        boolean found = false;

        // Find and update
        for (int i = 0; i < servers.size(); i++) {
            JsonObject s = servers.get(i).getAsJsonObject();
            if (s.has("id") && s.get("id").getAsString().equals(serverId)) {
                servers.set(i, server); // Replace
                found = true;
                break;
            }
        }

        if (!found) {
            servers.add(server);
        }

        configWriter.accept(config);
        LOG.info("[McpServerManager] Upserted MCP server in ~/.codemoss/config.json: " + serverId);
    }

    /**
     * Delete an MCP server.
     * Prefers deleting from ~/.claude.json (standard Claude CLI location),
     * falling back to ~/.codemoss/config.json.
     */
    public boolean deleteMcpServer(String serverId) throws IOException {
        return deleteMcpServer(serverId, null);
    }

    /**
     * Delete an MCP server (with project path support).
     * If the server has source="project", it will be removed from the project's
     * .mcp.json file instead of ~/.claude.json.
     *
     * @param serverId the server ID to delete
     * @param projectPath the project root path (for .mcp.json support)
     */
    public boolean deleteMcpServer(String serverId, String projectPath) throws IOException {
        boolean removed = false;

        // 0. If a projectPath is provided, try deleting from .mcp.json first
        if (projectPath != null && !projectPath.isEmpty()) {
            removed = deleteFromProjectMcpJson(serverId, projectPath);
            if (removed) {
                LOG.info("[McpServerManager] Deleted MCP server from .mcp.json at " + projectPath + ": " + serverId);
                return true;
            }
        }

        // 1. Try to delete from ~/.claude.json
        try {
            String homeDir = NodeDetector.resolveHomeForFileOps();
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (claudeJsonFile.exists()) {
                try (FileReader reader = new FileReader(claudeJsonFile, StandardCharsets.UTF_8)) {
                    JsonObject claudeJson = JsonParser.parseReader(reader).getAsJsonObject();

                    if (claudeJson.has("mcpServers") && claudeJson.get("mcpServers").isJsonObject()) {
                        JsonObject mcpServers = claudeJson.getAsJsonObject("mcpServers");

                        if (mcpServers.has(serverId)) {
                            // Delete the server
                            mcpServers.remove(serverId);

                            // Also remove from disabledMcpServers (if present)
                            if (claudeJson.has("disabledMcpServers") && claudeJson.get("disabledMcpServers").isJsonArray()) {
                                JsonArray disabledServers = claudeJson.getAsJsonArray("disabledMcpServers");
                                JsonArray newDisabled = new JsonArray();
                                for (JsonElement elem : disabledServers) {
                                    if (!elem.getAsString().equals(serverId)) {
                                        newDisabled.add(elem);
                                    }
                                }
                                claudeJson.add("disabledMcpServers", newDisabled);
                            }

                            // Write back to file
                            try (FileWriter writer = new FileWriter(claudeJsonFile, StandardCharsets.UTF_8)) {
                                gson.toJson(claudeJson, writer);
                                writer.flush();  // Ensure data is fully flushed to disk
                            }

                            LOG.info("[McpServerManager] Deleted MCP server from ~/.claude.json: " + serverId);

                            // Sync to settings.json (after file write is complete)
                            try {
                                claudeSettingsManager.syncMcpToClaudeSettings();
                            } catch (Exception syncError) {
                                LOG.warn("[McpServerManager] Failed to sync MCP to settings.json: " + syncError.getMessage());
                            }

                            removed = true;
                            return true;
                        }
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Error deleting from ~/.claude.json: " + e.getMessage());
        }

        // 2. Fall back to ~/.codemoss/config.json
        JsonObject config = configReader.apply(null);
        if (config.has("mcpServers")) {
            JsonArray servers = config.getAsJsonArray("mcpServers");
            JsonArray newServers = new JsonArray();

            for (JsonElement elem : servers) {
                JsonObject s = elem.getAsJsonObject();
                if (s.has("id") && s.get("id").getAsString().equals(serverId)) {
                    removed = true;
                } else {
                    newServers.add(s);
                }
            }

            if (removed) {
                config.add("mcpServers", newServers);
                configWriter.accept(config);
                LOG.info("[McpServerManager] Deleted MCP server from ~/.codemoss/config.json: " + serverId);
            }
        }

        return removed;
    }

    /**
     * Validate MCP server configuration.
     */
    public Map<String, Object> validateMcpServer(JsonObject server) {
        List<String> errors = new ArrayList<>();

        if (!server.has("name") || server.get("name").getAsString().isEmpty()) {
            errors.add("Server name must not be empty");
        }

        if (server.has("server")) {
            JsonObject serverSpec = server.getAsJsonObject("server");
            String type = serverSpec.has("type") ? serverSpec.get("type").getAsString() : "stdio";

            if ("stdio".equals(type)) {
                if (!serverSpec.has("command") || serverSpec.get("command").getAsString().isEmpty()) {
                    errors.add("Command must not be empty");
                }
            } else if ("http".equals(type) || "sse".equals(type)) {
                if (!serverSpec.has("url") || serverSpec.get("url").getAsString().isEmpty()) {
                    errors.add("URL must not be empty");
                } else {
                    String url = serverSpec.get("url").getAsString();
                    try {
                        new java.net.URI(url).toURL();
                    } catch (Exception e) {
                        errors.add("Invalid URL format");
                    }
                }
            } else {
                errors.add("Unsupported connection type: " + type);
            }
        } else {
            errors.add("Missing server configuration details");
        }

        Map<String, Object> result = new HashMap<>();
        result.put("valid", errors.isEmpty());
        result.put("errors", errors);
        return result;
    }

    /**
     * Read project-level .mcp.json from the project root directory.
     * Servers from .mcp.json are marked with source="project" and enabled=true
     * so the webview can display them as read-only (managed on-disk).
     *
     * @param projectPath the project root directory
     * @return list of MCP server JsonObject entries, marked as project-local
     */
    /**
     * Upsert (update or insert) an MCP server in the project-level .mcp.json file.
     * The server's spec is extracted from the "server" field (or flattened if absent).
     * @param server the server JsonObject (with id, name, enabled, server spec, etc.)
     * @param serverId the server ID
     * @param isEnabled whether the server is enabled
     * @param projectPath the project root directory
     * @return true if the operation succeeded, false otherwise
     */
    private boolean upsertInProjectMcpJson(JsonObject server, String serverId, boolean isEnabled, String projectPath) {
        File mcpJsonFile = Paths.get(projectPath, ".mcp.json").toFile();
        if (!mcpJsonFile.exists()) {
            LOG.warn("[McpServerManager] .mcp.json not found at " + projectPath + ", cannot upsert");
            return false;
        }

        try (FileReader reader = new FileReader(mcpJsonFile, StandardCharsets.UTF_8)) {
            JsonObject projectConfig = JsonParser.parseReader(reader).getAsJsonObject();
            if (!projectConfig.has("mcpServers") || !projectConfig.get("mcpServers").isJsonObject()) {
                projectConfig.add("mcpServers", new JsonObject());
            }
            JsonObject mcpServers = projectConfig.getAsJsonObject("mcpServers");

            // Extract server spec from "server" field, or build from server itself
            JsonObject serverSpec;
            if (server.has("server") && server.get("server").isJsonObject()) {
                serverSpec = server.getAsJsonObject("server").deepCopy();
            } else {
                serverSpec = server.deepCopy();
                serverSpec.remove("id");
                serverSpec.remove("name");
                serverSpec.remove("enabled");
                serverSpec.remove("apps");
                serverSpec.remove("server");
                serverSpec.remove("source");
            }

            mcpServers.add(serverId, serverSpec);

            // Update disabledMcpServers list
            if (!projectConfig.has("disabledMcpServers") || !projectConfig.get("disabledMcpServers").isJsonArray()) {
                projectConfig.add("disabledMcpServers", new JsonArray());
            }
            JsonArray disabledArray = projectConfig.getAsJsonArray("disabledMcpServers");
            JsonArray newDisabled = new JsonArray();
            for (JsonElement elem : disabledArray) {
                if (elem.isJsonPrimitive() && !elem.getAsString().equals(serverId)) {
                    newDisabled.add(elem);
                }
            }
            if (!isEnabled) {
                newDisabled.add(serverId);
            }
            projectConfig.add("disabledMcpServers", newDisabled);

            try (FileWriter writer = new FileWriter(mcpJsonFile, StandardCharsets.UTF_8)) {
                gson.toJson(projectConfig, writer);
                writer.flush();
            }

            return true;
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Failed to upsert in .mcp.json at " + projectPath + ": " + e.getMessage());
            return false;
        }
    }

    private List<JsonObject> loadProjectMcpJson(String projectPath) {
        List<JsonObject> servers = new ArrayList<>();
        Set<String> disabledServers = new HashSet<>();
        if (projectPath == null || projectPath.isEmpty()) {
            return servers;
        }

        File mcpJsonFile = Paths.get(projectPath, ".mcp.json").toFile();
        if (!mcpJsonFile.exists()) {
            LOG.info("[McpServerManager] .mcp.json not found at " + projectPath);
            return servers;
        }

        try (FileReader reader = new FileReader(mcpJsonFile, StandardCharsets.UTF_8)) {
            JsonObject projectConfig = JsonParser.parseReader(reader).getAsJsonObject();

            if (projectConfig.has("mcpServers") && projectConfig.get("mcpServers").isJsonObject()) {
                JsonObject projectMcpServers = projectConfig.getAsJsonObject("mcpServers");
                if (projectConfig.has("disabledMcpServers") && projectConfig.get("disabledMcpServers").isJsonArray()) {
                    JsonArray disabledArray = projectConfig.getAsJsonArray("disabledMcpServers");
                    for (JsonElement elem : disabledArray) {
                        if (elem.isJsonPrimitive()) {
                            disabledServers.add(elem.getAsString());
                        }
                    }
                }

                for (String serverId : projectMcpServers.keySet()) {
                    JsonElement serverElem = projectMcpServers.get(serverId);
                    if (serverElem.isJsonObject()) {
                        JsonObject server = serverElem.getAsJsonObject();

                        // Ensure id and name fields exist
                        if (!server.has("id")) {
                            server.addProperty("id", serverId);
                        }
                        if (!server.has("name")) {
                            server.addProperty("name", serverId);
                        }

                        // Wrap type, command, args, env, etc. into the server field
                        if (!server.has("server")) {
                            JsonObject serverSpec = new JsonObject();

                            Set<String> excludedFields = new HashSet<>();
                            excludedFields.add("id");
                            excludedFields.add("name");
                            excludedFields.add("enabled");
                            excludedFields.add("apps");
                            excludedFields.add("server");

                            for (String key : server.keySet()) {
                                if (!excludedFields.contains(key)) {
                                    serverSpec.add(key, server.get(key));
                                }
                            }

                            server.add("server", serverSpec);
                        }

                        // Mark as project-local (read-only in UI)
                        server.addProperty("source", "project");

                        // Set enabled/disabled status
                        boolean isEnabled = !disabledServers.contains(serverId);
                        server.addProperty("enabled", isEnabled);

                        servers.add(server);
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Failed to read .mcp.json at " + projectPath + ": " + e.getMessage());
        }

        LOG.info("[McpServerManager] Loaded " + servers.size()
                 + " MCP servers from .mcp.json at " + projectPath
                 + " (disabled: " + disabledServers.size() + ")");
        return servers;
    }

    /**
     * Delete an MCP server from the project-level .mcp.json file.
     * @param serverId the server ID to remove
     * @param projectPath the project root directory
     * @return true if the server was found and removed, false otherwise
     */
    private boolean deleteFromProjectMcpJson(String serverId, String projectPath) {
        if (projectPath == null || projectPath.isEmpty()) {
            return false;
        }

        File mcpJsonFile = Paths.get(projectPath, ".mcp.json").toFile();
        if (!mcpJsonFile.exists()) {
            return false;
        }

        try (FileReader reader = new FileReader(mcpJsonFile, StandardCharsets.UTF_8)) {
            JsonObject projectConfig = JsonParser.parseReader(reader).getAsJsonObject();
            if (!projectConfig.has("mcpServers") || !projectConfig.get("mcpServers").isJsonObject()) {
                return false;
            }

            JsonObject mcpServers = projectConfig.getAsJsonObject("mcpServers");
            if (!mcpServers.has(serverId)) {
                return false;
            }

            mcpServers.remove(serverId);

            // Write back to file
            try (FileWriter writer = new FileWriter(mcpJsonFile, StandardCharsets.UTF_8)) {
                gson.toJson(projectConfig, writer);
                writer.flush();
            }

            return true;
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Failed to update .mcp.json at " + projectPath + ": " + e.getMessage());
            return false;
        }
    }
}

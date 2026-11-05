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
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.LinkedHashMap;
import java.util.TreeMap;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.regex.Pattern;

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
        Map<String, JsonObject> byId = new LinkedHashMap<>();

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

                                // A user-scope server is not behind the project approval gate
                                // at all, so there is no unverified caveat to report.
                                server.addProperty(KEY_TRUST_VERIFIED, true);

                                byId.put(serverId, server);
                            }
                        }

                        // 1b. Merge project-level .mcp.json servers from project root (if projectPath provided)
                        if (projectPath != null) {
                            List<JsonObject> projectJsonServers = loadProjectMcpJson(projectPath);
                            if (!projectJsonServers.isEmpty()) {
                                mergeProjectMcpJsonServers(byId, projectJsonServers);
                                LOG.info("[McpServerManager] Merged " + projectJsonServers.size()
                                         + " MCP servers from .mcp.json at " + projectPath);
                            }
                        }

                        List<JsonObject> result = new ArrayList<>(byId.values());
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
                mergeProjectMcpJsonServers(byId, projectJsonServers);
                LOG.info("[McpServerManager] Loaded " + projectJsonServers.size()
                        + " MCP servers from .mcp.json at " + projectPath);
            }
        }
        JsonObject config = configReader.apply(null);
        if (config.has("mcpServers")) {
            JsonArray servers = config.getAsJsonArray("mcpServers");
            for (JsonElement elem : servers) {
                if (elem.isJsonObject()) {
                    JsonObject s = elem.getAsJsonObject();
                    String id = s.has("id") ? s.get("id").getAsString() : null;
                    // Same as the ~/.claude.json branch: outside the project gate.
                    s.addProperty(KEY_TRUST_VERIFIED, true);
                    if (id != null) {
                        byId.putIfAbsent(id, s);   // lowest priority
                    } else {
                        byId.put("__no_id__" + byId.size(), s);
                    }
                }
            }
        }

        List<JsonObject> result = new ArrayList<>(byId.values());
        LOG.info("[McpServerManager] Loaded " + result.size() + " MCP servers from ~/.codemoss/config.json");
        return result;
    }

    /**
     * Merge project-level .mcp.json servers into the accumulated server map.
     *
     * <p>A project-local server whose id collides with an already-merged server is
     * <b>never</b> allowed to silently replace it. Both records are kept: the
     * pre-existing record stays under its own id, and the project-local one is
     * stored under a synthetic key and flagged with {@code conflicting=true} plus
     * {@code conflictingWith=<source of the shadowed record>} so the UI can show
     * the collision instead of presenting an unauditable, read-only project card
     * that silently took over a trusted global server.
     *
     * @param byId               the accumulated id -> server map
     * @param projectJsonServers servers read from the project's .mcp.json
     */
    private static void mergeProjectMcpJsonServers(Map<String, JsonObject> byId, List<JsonObject> projectJsonServers) {
        for (JsonObject server : projectJsonServers) {
            String id = server.has("id") ? server.get("id").getAsString() : null;
            if (id == null) {
                byId.put("__no_id__" + byId.size(), server);
                continue;
            }
            JsonObject shadowed = byId.get(id);
            if (shadowed == null) {
                byId.put(id, server);
                continue;
            }
            String shadowedSource = shadowed.has("source")
                    ? shadowed.get("source").getAsString()
                    : "global";
            server.addProperty("conflicting", true);
            server.addProperty("conflictingWith", shadowedSource);
            byId.put("project::" + id + "::" + byId.size(), server);
            LOG.info("[McpServerManager] MCP server id collision: '" + id
                     + "' exists in both " + shadowedSource + " config and the project .mcp.json; "
                     + "both entries are kept and the project-local one is flagged as conflicting");
        }
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

            throw new IOException(
                    "Failed to upsert project-local MCP server in .mcp.json: " + serverId
                            + " at " + projectPath
            );
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
     * Settings keys for project-scoped .mcp.json server approval, mirroring the
     * JavaScript config-loader.js trust model.
     */
    static final String KEY_ENABLED_MCPJSON_SERVERS = "enabledMcpjsonServers";
    static final String KEY_DISABLED_MCPJSON_SERVERS = "disabledMcpjsonServers";
    static final String KEY_ENABLE_ALL_PROJECT_MCP = "enableAllProjectMcpServers";

    /**
     * Response field: whether git CONFIRMED the trust behind this server's
     * provenance/approval. {@code true} for user-scope servers and for servers
     * approved by user/managed settings or by a git-verified project-local file;
     * {@code false} when the approval rests solely on a project-local file in a
     * directory that is not a git repository, and when the approval gate granted
     * the server nothing. The UI must surface the {@code false} case instead of
     * presenting it as a plain approval.
     */
    static final String KEY_TRUST_VERIFIED = "trustVerified";

    /**
     * Map of approved server id -&gt; sha256 fingerprint of the spec that was approved.
     * An approval without a matching fingerprint is treated as "needs confirmation".
     */
    static final String KEY_MCPJSON_SERVER_FINGERPRINTS = "enabledMcpjsonServerFingerprints";

    /** Upper bound for a .mcp.json server id / key. */
    public static final int MAX_SERVER_ID_LENGTH = 128;

    /** A stored fingerprint must be exactly one lowercase sha256 hex digest. */
    private static final Pattern FINGERPRINT_PATTERN = Pattern.compile("^[0-9a-f]{64}$");

    /** Upper bound for a single git invocation; exceeding it means "cannot tell". */
    private static final long GIT_TIMEOUT_SECONDS = 5L;

    /** Upper bound on the stderr excerpt kept from a git invocation. */
    private static final int GIT_STDERR_LIMIT = 512;

    /**
     * Whether git tracks a given file.
     *
     * <p>Only ever used to decide whether a project-local settings file can be
     * treated as user-owned. Anything we cannot prove untracked is untrusted.
     * Package-private so unit tests can assert the fail-closed contract.
     */
    enum GitTrackingState {
        /** git reports the file is in the index — the repository can ship it. */
        TRACKED,
        /** git reports the file is ignored or simply not in the index. */
        UNTRACKED,
        /** git is missing, the call timed out, or git failed. */
        INDETERMINATE
    }

    /**
     * Result of asking git about a project-local settings file: the tracking
     * verdict plus whether git actually <em>confirmed</em> anything.
     *
     * <p>{@code verified} is false in the one case where {@link GitTrackingState#UNTRACKED}
     * is inferred rather than proven: the directory is not a git repository at all.
     * Nothing there can ever be committed, so an explicit list of approved server
     * names is still honoured (otherwise Approve would write a file that can never
     * count and the UI would sit at "pending" forever in every non-version-controlled
     * project) — but the trust rests on the absence of git, not on git's answer, and
     * the UI has to be told so.
     */
    static final class GitTrustVerdict {
        private final GitTrackingState tracking;
        private final boolean verified;

        GitTrustVerdict(GitTrackingState tracking, boolean verified) {
            this.tracking = tracking;
            this.verified = verified;
        }

        GitTrackingState getTracking() {
            return tracking;
        }

        /** True when git positively confirmed an enclosing work tree and the file. */
        boolean isVerified() {
            return verified;
        }
    }

    /**
     * The gate's verdict for one project-scoped .mcp.json server: its approval
     * state plus the {@code trustVerified} flag the UI has to surface.
     */
    public static final class ProjectMcpApproval {
        private final String status;
        private final boolean trustVerified;

        ProjectMcpApproval(String status, boolean trustVerified) {
            this.status = status;
            this.trustVerified = trustVerified;
        }

        /** @return "approved" | "pending" | "rejected" */
        public String getStatus() {
            return status;
        }

        /**
         * Whether the trust behind this server's approval is confirmed by git.
         *
         * <p>{@code true} — approved from user ~/.claude/settings.json, from managed
         * settings, or from a project-local file git proved is untracked and
         * git-ignored. {@code false} — either the gate granted this server nothing
         * (pending/rejected, so there is no verified provenance to claim), or its
         * approval rests solely on a project-local file in a directory that is not a
         * git repository.
         */
        public boolean isTrustVerified() {
            return trustVerified;
        }
    }

    /**
     * Resolve the approval status of a project-scoped .mcp.json server.
     *
     * Reads approval state from TRUSTED sources only (user ~/.claude/settings.json,
     * managed settings, and the project's own git-untracked .claude/settings.local.json),
     * explicitly NOT from the committed .claude/settings.json the repo can ship.
     *
     * @param serverId  the server name/key from .mcp.json
     * @param projectPath the project root directory
     * @return "approved" | "pending" | "rejected"
     */
    public String resolveProjectMcpApprovalStatus(String serverId, String projectPath) {
        return resolveProjectMcpApprovalStatus(serverId, projectPath, null);
    }

    /**
     * Resolve the approval status with a pre-computed fingerprint of the current
     * {@code .mcp.json} entry, so callers that already hold the raw spec do not pay
     * for a second read of the file.
     *
     * @param serverId    the server name/key from .mcp.json
     * @param projectPath the project root directory
     * @param fingerprint sha256 of the server spec, or null when it cannot be computed
     * @return "approved" | "pending" | "rejected"
     */
    public String resolveProjectMcpApprovalStatus(String serverId, String projectPath, String fingerprint) {
        return resolveProjectMcpApproval(serverId, projectPath, fingerprint).getStatus();
    }

    /**
     * Resolve the approval status together with the {@code trustVerified} flag.
     *
     * @param serverId    the server name/key from .mcp.json
     * @param projectPath the project root directory
     * @param fingerprint sha256 of the server spec, or null when it cannot be computed
     * @return the status plus whether git confirmed the trust behind the approval
     */
    public ProjectMcpApproval resolveProjectMcpApproval(String serverId, String projectPath, String fingerprint) {
        try {
            Set<String> approved = new HashSet<>();
            Set<String> denied = new HashSet<>();
            Set<String> unverifiedApprovals = new HashSet<>();
            Map<String, String> fingerprints = new HashMap<>();
            boolean enableAll = false;

            // 1. User ~/.claude/settings.json (trusted, outside any repository)
            JsonObject userSettings = readTrustedSettings(
                    Paths.get(NodeDetector.resolveHomeForFileOps(), ".claude", "settings.json").toFile(),
                    "user settings.json");
            if (userSettings != null) {
                enableAll = enableAll || readBooleanSetting(userSettings, KEY_ENABLE_ALL_PROJECT_MCP);
                readServerListSetting(userSettings, KEY_ENABLED_MCPJSON_SERVERS, approved);
                readServerListSetting(userSettings, KEY_DISABLED_MCPJSON_SERVERS, denied);
                readFingerprintSetting(userSettings, fingerprints);
            }

            // 2. Managed settings (trusted, outside any repository)
            Path managedPath = new ConfigPathManager().getManagedSettingsPath();
            if (managedPath != null) {
                JsonObject managedSettings = readTrustedSettings(managedPath.toFile(), "managed-settings.json");
                if (managedSettings != null) {
                    enableAll = enableAll || readBooleanSetting(managedSettings, KEY_ENABLE_ALL_PROJECT_MCP);
                    readServerListSetting(managedSettings, KEY_ENABLED_MCPJSON_SERVERS, approved);
                    readServerListSetting(managedSettings, KEY_DISABLED_MCPJSON_SERVERS, denied);
                    readFingerprintSetting(managedSettings, fingerprints);
                }
            }

            // 3. Project's .claude/settings.local.json — accepted ONLY when the file
            //    cannot be part of a repository, and then only for the explicit
            //    per-server lists. enableAllProjectMcpServers is never honoured from
            //    this scope: a repository that can commit the file can otherwise
            //    pre-approve every server it ships in .mcp.json.
            if (projectPath != null && !projectPath.isEmpty()) {
                readProjectLocalApprovalSettings(projectPath, approved, denied, fingerprints, unverifiedApprovals);
            }

            // Denial always wins
            if (denied.contains(serverId)) {
                return new ProjectMcpApproval("rejected", false);
            }
            // A blanket opt-in only ever comes from user/managed scope, so it is
            // always git-verified by construction.
            if (enableAll) {
                return new ProjectMcpApproval("approved", true);
            }
            if (!approved.contains(serverId)) {
                return new ProjectMcpApproval("pending", false);
            }
            // An explicit approval is only honoured while the spec it was granted for
            // is unchanged. Legacy entries (no fingerprint at all) require re-confirmation.
            if (!approvalMatchesFingerprint(serverId, projectPath, fingerprint, fingerprints)) {
                return new ProjectMcpApproval("pending", false);
            }
            // A name listed by several sources counts as verified when any of them is
            // user/managed scope or a git-verified project-local file.
            return new ProjectMcpApproval("approved", !unverifiedApprovals.contains(serverId));
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Failed to resolve approval status for " + serverId + ": " + e.getMessage());
            return new ProjectMcpApproval("pending", false);
        }
    }

    /**
     * Read the project's .claude/settings.local.json, but only when no repository can
     * ship the file. Everything else is ignored so a malicious repository cannot carry
     * its own approval gate.
     *
     * <p>Names this call approves are added to {@code unverifiedApprovals} when git did
     * not confirm the file — that is, when the project directory is not a repository at
     * all. The approval still applies (Approve must keep working there), but the
     * resulting verdict reports trustVerified=false so the UI can say the trust is
     * unconfirmed.
     *
     * @param projectPath         the project root directory
     * @param approved            collects the enabledMcpjsonServers names
     * @param denied              collects the disabledMcpjsonServers names
     * @param fingerprints        collects the stored spec fingerprints
     * @param unverifiedApprovals collects names approved without a git-confirmed file
     */
    private void readProjectLocalApprovalSettings(String projectPath,
                                                  Set<String> approved,
                                                  Set<String> denied,
                                                  Map<String, String> fingerprints,
                                                  Set<String> unverifiedApprovals) {
        Path projectDir = Paths.get(projectPath);
        Path settingsLocalPath = projectDir.resolve(".claude").resolve("settings.local.json");
        if (!Files.exists(settingsLocalPath)) {
            return;
        }

        GitTrustVerdict verdict = detectGitTrust(projectDir, settingsLocalPath);
        if (verdict.getTracking() == GitTrackingState.TRACKED) {
            LOG.info("[McpServerManager] Ignoring git-tracked project settings file for MCP approval: "
                     + settingsLocalPath + " — a repository can ship this file, so it is not user-owned");
            return;
        }
        if (verdict.getTracking() == GitTrackingState.INDETERMINATE) {
            LOG.info("[McpServerManager] Could not determine git tracking for " + settingsLocalPath
                     + " — treating it as untrusted for MCP approval (fail-closed)");
            return;
        }
        if (!verdict.isVerified()) {
            LOG.info("[McpServerManager] Project dir is not a git repository; reading explicit "
                     + "enabledMcpjsonServers from " + settingsLocalPath
                     + ", but the trust is NOT git-verified");
        }

        JsonObject projectSettings = readTrustedSettings(settingsLocalPath.toFile(), "project settings.local.json");
        if (projectSettings == null) {
            return;
        }
        // Deliberately NOT reading KEY_ENABLE_ALL_PROJECT_MCP here — see step 3 above.
        Set<String> localApproved = new HashSet<>();
        readServerListSetting(projectSettings, KEY_ENABLED_MCPJSON_SERVERS, localApproved);
        readServerListSetting(projectSettings, KEY_DISABLED_MCPJSON_SERVERS, denied);
        readFingerprintSetting(projectSettings, fingerprints);
        approved.addAll(localApproved);
        if (!verdict.isVerified()) {
            unverifiedApprovals.addAll(localApproved);
        }
    }

    /**
     * Ask git whether {@code file} is tracked by the repository containing {@code workingDir},
     * and whether git actually confirmed that.
     *
     * <p>First establishes whether the directory is inside a git work tree at all:
     * <ul>
     *   <li>git missing, a timeout, or any other failure to answer that question is a
     *       doubtful case and yields {@link GitTrackingState#INDETERMINATE};</li>
     *   <li>a definitive "not a git repository" answer means nothing here can ever be
     *       committed, so the file is untracked by definition — without that answer
     *       every non-version-controlled project would be permanently un-approvable —
     *       but the verdict is reported with {@code verified=false}, because the
     *       untracked claim comes from the absence of a repository, not from git.</li>
     * </ul>
     *
     * <p>Inside a work tree the decision comes from {@code git check-ignore} (a file
     * matched by .gitignore can never be committed, so it is untracked by definition)
     * and {@code git ls-files --error-unmatch}; either answer there is git speaking
     * about the file, so the verdict is verified. All commands run through
     * {@link ProcessBuilder} with an argument array — never a shell — and with a timeout.
     *
     * <p>Package-private so it can be exercised directly by unit tests.
     */
    static GitTrustVerdict detectGitTrust(Path workingDir, Path file) {
        GitResult insideWorkTree = runGit(workingDir, "rev-parse", "--is-inside-work-tree");
        if (insideWorkTree == null) {
            return new GitTrustVerdict(GitTrackingState.INDETERMINATE, false);
        }
        if (insideWorkTree.exitCode == 0) {
            // inside a work tree — ask git about the file itself below
        } else if (isNotARepositoryFailure(insideWorkTree)) {
            return new GitTrustVerdict(GitTrackingState.UNTRACKED, false);
        } else {
            return new GitTrustVerdict(GitTrackingState.INDETERMINATE, false);
        }

        GitResult ignored = runGit(workingDir, "check-ignore", "-q", "--", file.toAbsolutePath().toString());
        if (ignored == null || ignored.exitCode > 1) {
            return new GitTrustVerdict(GitTrackingState.INDETERMINATE, false);
        }
        if (ignored.exitCode == 0) {
            return new GitTrustVerdict(GitTrackingState.UNTRACKED, true);
        }

        GitResult listed = runGit(workingDir, "ls-files", "--error-unmatch", "--",
                file.toAbsolutePath().toString());
        if (listed == null) {
            return new GitTrustVerdict(GitTrackingState.INDETERMINATE, false);
        }
        if (listed.exitCode == 0) {
            return new GitTrustVerdict(GitTrackingState.TRACKED, true);
        }
        if (listed.exitCode == 1) {
            return new GitTrustVerdict(GitTrackingState.UNTRACKED, true);
        }
        return new GitTrustVerdict(GitTrackingState.INDETERMINATE, false);
    }

    /**
     * Tracking verdict only, for callers that do not care whether git confirmed it.
     * Package-private so unit tests can assert the fail-closed contract.
     */
    static GitTrackingState detectGitTrackingState(Path workingDir, Path file) {
        return detectGitTrust(workingDir, file).getTracking();
    }

    /**
     * Whether git's failure is the specific "this directory is not a repository" answer
     * rather than something we failed to understand. Only git's own untranslated
     * {@code fatal: not a git repository} is accepted; anything else stays doubtful.
     */
    private static boolean isNotARepositoryFailure(GitResult result) {
        return result.exitCode == 128 && result.stderr.contains("not a git repository");
    }

    /** Exit code plus a bounded copy of git's stderr, for classifying failures. */
    private static final class GitResult {
        private final int exitCode;
        private final String stderr;

        GitResult(int exitCode, String stderr) {
            this.exitCode = exitCode;
            this.stderr = stderr;
        }
    }

    /**
     * Run {@code git <args>} in {@code workingDir}. Never uses a shell and always
     * applies a timeout.
     *
     * @return the exit code and a bounded stderr excerpt, or null when git could not be
     *         run at all (missing, not executable, or the call timed out)
     */
    private static GitResult runGit(Path workingDir, String... args) {
        List<String> command = new ArrayList<>();
        command.add("git");
        command.addAll(Arrays.asList(args));

        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(workingDir.toFile());
        builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
        builder.redirectErrorStream(false);

        Process process = null;
        try {
            process = builder.start();
            String stderr = readBoundedStderr(process);
            if (!process.waitFor(GIT_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                return null;
            }
            return new GitResult(process.exitValue(), stderr);
        } catch (IOException e) {
            // git is not installed, not on PATH, or not executable
            LOG.info("[McpServerManager] git is unavailable while checking MCP approval trust: " + e.getMessage());
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } finally {
            if (process != null) {
                process.destroy();
            }
        }
    }

    /**
     * Drain at most {@link #GIT_STDERR_LIMIT} bytes of git's stderr so it cannot fill
     * the pipe buffer and deadlock the process we are waiting on. The content is only
     * ever used to classify failures; it is never logged.
     */
    private static String readBoundedStderr(Process process) {
        try (InputStream stream = process.getErrorStream()) {
            byte[] buffer = new byte[GIT_STDERR_LIMIT];
            int read = stream.readNBytes(buffer, 0, buffer.length);
            return new String(buffer, 0, Math.max(read, 0), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    /**
     * True when the stored fingerprint for {@code serverId} matches the fingerprint of
     * the server spec as it exists right now. A missing or malformed stored fingerprint
     * (i.e. every approval written before fingerprints existed) fails this check, so it
     * is reported as "needs confirmation" rather than as trusted.
     */
    private static boolean approvalMatchesFingerprint(String serverId,
                                                      String projectPath,
                                                      String fingerprint,
                                                      Map<String, String> fingerprints) {
        String stored = fingerprints.get(serverId);
        if (stored == null || stored.isEmpty()) {
            LOG.info("[McpServerManager] MCP server approval '" + serverId
                     + "' has no stored fingerprint; requiring re-confirmation");
            return false;
        }
        String current = fingerprint != null ? fingerprint : fingerprintOfProjectServer(projectPath, serverId);
        if (current == null) {
            return false;
        }
        return MessageDigest.isEqual(
                stored.getBytes(StandardCharsets.UTF_8),
                current.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Read the {@code enabledMcpjsonServerFingerprints} map, keeping only well-formed digests.
     */
    private static void readFingerprintSetting(JsonObject settings, Map<String, String> target) {
        if (!settings.has(KEY_MCPJSON_SERVER_FINGERPRINTS)
                || !settings.get(KEY_MCPJSON_SERVER_FINGERPRINTS).isJsonObject()) {
            return;
        }
        for (Map.Entry<String, JsonElement> entry : settings.getAsJsonObject(KEY_MCPJSON_SERVER_FINGERPRINTS).entrySet()) {
            JsonElement value = entry.getValue();
            if (!value.isJsonPrimitive()) {
                continue;
            }
            String digest = value.getAsString();
            if (FINGERPRINT_PATTERN.matcher(digest).matches()) {
                target.put(entry.getKey(), digest);
            }
        }
    }

    /**
     * Compute the sha256 fingerprint of a raw {@code .mcp.json} server entry.
     *
     * <p>Covers the fields that decide what actually executes: connection type,
     * command, arguments, environment, and the remote URL. Argument order is
     * significant; environment keys are sorted so reordering is not a change.
     * Values are only ever hashed, never logged.
     *
     * @param spec the raw entry from .mcp.json
     * @return lowercase hex digest, or null when the spec is unusable
     */
    static String fingerprintOfServerSpec(JsonObject spec) {
        if (spec == null || !spec.isJsonObject()) {
            return null;
        }
        JsonObject serverSpec = spec.has("server") && spec.get("server").isJsonObject()
                ? spec.getAsJsonObject("server")
                : spec;

        StringBuilder canonical = new StringBuilder();
        canonical.append("type=").append(readStringField(serverSpec, "type")).append('\n');
        canonical.append("command=").append(readStringField(serverSpec, "command")).append('\n');
        canonical.append("url=").append(readStringField(serverSpec, "url")).append('\n');

        if (serverSpec.has("args") && serverSpec.get("args").isJsonArray()) {
            for (JsonElement arg : serverSpec.getAsJsonArray("args")) {
                canonical.append("arg=").append(arg.isJsonPrimitive() ? arg.getAsString() : arg.toString())
                        .append('\n');
            }
        }

        if (serverSpec.has("env") && serverSpec.get("env").isJsonObject()) {
            Map<String, String> env = new TreeMap<>();
            for (Map.Entry<String, JsonElement> entry : serverSpec.getAsJsonObject("env").entrySet()) {
                JsonElement value = entry.getValue();
                env.put(entry.getKey(), value.isJsonPrimitive() ? value.getAsString() : value.toString());
            }
            for (Map.Entry<String, String> entry : env.entrySet()) {
                canonical.append("env=").append(entry.getKey()).append('=').append(entry.getValue()).append('\n');
            }
        }

        return sha256Hex(canonical.toString());
    }

    /**
     * Fingerprint of a server as currently declared in the project's .mcp.json.
     *
     * @return lowercase hex digest, or null when the file is missing/unreadable
     */
    static String fingerprintOfProjectServer(String projectPath, String serverId) {
        if (projectPath == null || projectPath.isEmpty() || serverId == null) {
            return null;
        }
        return fingerprintOfServerSpec(readProjectMcpServerSpec(projectPath, serverId));
    }

    /**
     * Read a single raw entry out of the project's .mcp.json.
     *
     * @return the raw JsonObject, or null when absent or the file cannot be parsed
     */
    static JsonObject readProjectMcpServerSpec(String projectPath, String serverId) {
        if (projectPath == null || projectPath.isEmpty() || serverId == null) {
            return null;
        }
        File mcpJsonFile = Paths.get(projectPath, ".mcp.json").toFile();
        if (!mcpJsonFile.exists()) {
            return null;
        }
        try (FileReader reader = new FileReader(mcpJsonFile, StandardCharsets.UTF_8)) {
            JsonObject projectConfig = JsonParser.parseReader(reader).getAsJsonObject();
            if (projectConfig == null || !projectConfig.has("mcpServers")
                    || !projectConfig.get("mcpServers").isJsonObject()) {
                return null;
            }
            JsonObject mcpServers = projectConfig.getAsJsonObject("mcpServers");
            if (!mcpServers.has(serverId) || !mcpServers.get(serverId).isJsonObject()) {
                return null;
            }
            return mcpServers.getAsJsonObject(serverId).deepCopy();
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Failed to read .mcp.json entry '" + serverId + "': " + e.getMessage());
            return null;
        }
    }

    private static String readStringField(JsonObject spec, String key) {
        if (!spec.has(key) || !spec.get(key).isJsonPrimitive()) {
            return "";
        }
        return spec.get(key).getAsString();
    }

    private static String sha256Hex(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16));
                hex.append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            LOG.warn("[McpServerManager] SHA-256 is unavailable: " + e.getMessage());
            return null;
        }
    }

    /**
     * Validate a project .mcp.json server id coming from the webview.
     *
     * <p>Rejects null/empty ids, ids longer than {@link #MAX_SERVER_ID_LENGTH}, ids
     * containing control characters, and ids that are not actually declared as a key
     * in the project's .mcp.json.
     *
     * @return null when the id is acceptable, otherwise a human-readable reason
     */
    public static String validateProjectMcpServerId(String serverId, String projectPath) {
        if (serverId == null || serverId.isEmpty()) {
            return "server id is empty";
        }
        if (serverId.length() > MAX_SERVER_ID_LENGTH) {
            return "server id exceeds " + MAX_SERVER_ID_LENGTH + " characters";
        }
        for (int i = 0; i < serverId.length(); i++) {
            char c = serverId.charAt(i);
            if (c < 0x20 || c == 0x7F) {
                return "server id contains a control character";
            }
        }
        if (projectPath == null || projectPath.isEmpty()) {
            return "project path is empty";
        }
        if (!Paths.get(projectPath, ".mcp.json").toFile().exists()) {
            return "the project has no .mcp.json";
        }
        if (readProjectMcpServerSpec(projectPath, serverId) == null) {
            return "server '" + serverId + "' is not declared in the project .mcp.json";
        }
        return null;
    }

    /**
     * Read a settings file, tolerating missing/unparseable content.
     * @param file the settings file
     * @param label human-readable label for logging
     * @return parsed JsonObject, or null
     */
    private JsonObject readTrustedSettings(File file, String label) {
        if (!file.exists()) {
            return null;
        }
        try (FileReader reader = new FileReader(file, StandardCharsets.UTF_8)) {
            JsonObject parsed = JsonParser.parseReader(reader).getAsJsonObject();
            if (parsed == null || parsed.isJsonNull()) {
                LOG.warn("[McpServerManager] " + label + " is empty or null; skipping");
                return null;
            }
            return parsed;
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Failed to read " + label + ": " + e.getMessage());
            return null;
        }
    }

    /**
     * Read a boolean setting from a JsonObject.
     */
    private boolean readBooleanSetting(JsonObject settings, String key) {
        return settings.has(key) && settings.get(key).isJsonPrimitive()
                && settings.get(key).getAsBoolean();
    }

    /**
     * Read a string list setting from a JsonObject into a Set.
     */
    private void readServerListSetting(JsonObject settings, String key, Set<String> target) {
        if (!settings.has(key) || !settings.get(key).isJsonArray()) {
            return;
        }
        JsonArray arr = settings.getAsJsonArray(key);
        for (JsonElement elem : arr) {
            if (elem.isJsonPrimitive() && elem.getAsString() != null && !elem.getAsString().isEmpty()) {
                target.add(elem.getAsString());
            }
        }
    }

    /**
     * Remove every string element equal to {@code value} from a JsonArray.
     *
     * Gson's JsonArray implements Iterable but no longer extends List, so the
     * Collection helpers (removeIf) are not available on the compile classpath.
     * Walk the indices backwards so earlier removals cannot shift later ones.
     */
    private static void removeStringElement(JsonArray array, String value) {
        for (int i = array.size() - 1; i >= 0; i--) {
            JsonElement elem = array.get(i);
            if (elem.isJsonPrimitive() && value.equals(elem.getAsString())) {
                array.remove(i);
            }
        }
    }

    /**
     * Approve a project-scoped .mcp.json server by writing to the project's
     * untracked .claude/settings.local.json. Approving removes the server from
     * disabledMcpjsonServers and adds it to enabledMcpjsonServers.
     *
     * @param serverId    the server name from .mcp.json
     * @param projectPath the project root directory
     * @throws IOException if writing fails
     */
    public void approveProjectMcpJsonServer(String serverId, String projectPath) throws IOException {
        updateProjectMcpApproval(serverId, projectPath, true);
    }

    /**
     * Reject a project-scoped .mcp.json server by writing to the project's
     * untracked .claude/settings.local.json. Rejecting removes the server from
     * enabledMcpjsonServers and adds it to disabledMcpjsonServers.
     *
     * @param serverId    the server name from .mcp.json
     * @param projectPath the project root directory
     * @throws IOException if writing fails
     */
    public void rejectProjectMcpJsonServer(String serverId, String projectPath) throws IOException {
        updateProjectMcpApproval(serverId, projectPath, false);
    }

    /**
     * Update the approval state of a project-scoped .mcp.json server in the
     * project's .claude/settings.local.json, preserving all other keys.
     *
     * <p>The write is deliberately paranoid because the file is reachable from an
     * untrusted repository:
     * <ul>
     *   <li>the server id is validated and must exist in the project's .mcp.json;</li>
     *   <li>the target may not be a symbolic link, and its real path must stay inside
     *       the real project directory (a symlinked {@code .claude} or
     *       {@code settings.local.json} would otherwise let one click rewrite the
     *       user's global {@code ~/.claude/settings.json});</li>
     *   <li>an existing file that cannot be parsed aborts the operation untouched
     *       instead of being replaced by a two-key stub;</li>
     *   <li>the new content is written to a temp file in the same directory and moved
     *       into place with {@code ATOMIC_MOVE}.</li>
     * </ul>
     *
     * @param serverId    the server name from .mcp.json
     * @param projectPath the project root directory
     * @param approve     true to approve, false to reject
     * @throws IOException if the id is invalid, the target is unsafe, or writing fails
     */
    private void updateProjectMcpApproval(String serverId, String projectPath, boolean approve) throws IOException {
        if (projectPath == null || projectPath.isEmpty()) {
            throw new IOException("Cannot update MCP approval: project path is empty");
        }

        String invalidId = validateProjectMcpServerId(serverId, projectPath);
        if (invalidId != null) {
            throw new IOException("Cannot update MCP approval: " + invalidId);
        }

        Path settingsLocalPath = resolveSafeSettingsLocalPath(projectPath);

        JsonObject settings = new JsonObject();
        if (Files.exists(settingsLocalPath)) {
            settings = readSettingsLocalForUpdate(settingsLocalPath);
        }

        // Ensure arrays exist
        if (!settings.has(KEY_ENABLED_MCPJSON_SERVERS) || !settings.get(KEY_ENABLED_MCPJSON_SERVERS).isJsonArray()) {
            settings.add(KEY_ENABLED_MCPJSON_SERVERS, new JsonArray());
        }
        if (!settings.has(KEY_DISABLED_MCPJSON_SERVERS) || !settings.get(KEY_DISABLED_MCPJSON_SERVERS).isJsonArray()) {
            settings.add(KEY_DISABLED_MCPJSON_SERVERS, new JsonArray());
        }

        JsonArray enabled = settings.getAsJsonArray(KEY_ENABLED_MCPJSON_SERVERS);
        JsonArray disabled = settings.getAsJsonArray(KEY_DISABLED_MCPJSON_SERVERS);

        if (!settings.has(KEY_MCPJSON_SERVER_FINGERPRINTS)
                || !settings.get(KEY_MCPJSON_SERVER_FINGERPRINTS).isJsonObject()) {
            settings.add(KEY_MCPJSON_SERVER_FINGERPRINTS, new JsonObject());
        }
        JsonObject fingerprints = settings.getAsJsonObject(KEY_MCPJSON_SERVER_FINGERPRINTS);

        if (approve) {
            // Add to enabled, remove from disabled
            removeStringElement(enabled, serverId);
            enabled.add(serverId);
            removeStringElement(disabled, serverId);
            // Bind the approval to the exact spec it was granted for. If .mcp.json is
            // later edited to point at a different binary, the approval no longer
            // matches and the server falls back to "pending".
            String fingerprint = fingerprintOfProjectServer(projectPath, serverId);
            if (fingerprint != null) {
                fingerprints.addProperty(serverId, fingerprint);
            } else {
                LOG.warn("[McpServerManager] Could not fingerprint .mcp.json entry '" + serverId
                         + "'; the approval will require re-confirmation");
                fingerprints.remove(serverId);
            }
        } else {
            // Add to disabled, remove from enabled
            removeStringElement(disabled, serverId);
            disabled.add(serverId);
            removeStringElement(enabled, serverId);
            fingerprints.remove(serverId);
        }

        settings.add(KEY_ENABLED_MCPJSON_SERVERS, enabled);
        settings.add(KEY_DISABLED_MCPJSON_SERVERS, disabled);
        settings.add(KEY_MCPJSON_SERVER_FINGERPRINTS, fingerprints);

        writeSettingsLocalAtomically(settingsLocalPath, settings);

        LOG.info("[McpServerManager] " + (approve ? "Approved" : "Rejected") + " project MCP server: " + serverId
                + " at " + projectPath);
    }

    /**
     * Resolve {@code <projectPath>/.claude/settings.local.json} and prove that writing
     * to it cannot escape the project.
     *
     * <p>Checks, in order: the project directory exists, {@code .claude} is not a
     * symlink, the real {@code .claude} directory is inside the real project, the
     * target file is not a symlink, and — when it already exists — its real path is
     * inside the real project too. A repository that ships
     * {@code .claude/settings.local.json} as a link to {@code ~/.claude/settings.json}
     * is rejected here rather than silently writing through the link.
     *
     * @return the validated settings.local.json path
     * @throws IOException if any of the checks fail
     */
    private static Path resolveSafeSettingsLocalPath(String projectPath) throws IOException {
        Path projectDir = Paths.get(projectPath).toAbsolutePath().normalize();
        if (!Files.isDirectory(projectDir)) {
            throw new IOException("Cannot update MCP approval: project directory does not exist: " + projectPath);
        }
        Path realProjectDir;
        try {
            realProjectDir = projectDir.toRealPath();
        } catch (IOException e) {
            throw new IOException("Cannot update MCP approval: cannot resolve the project directory: " + e.getMessage());
        }

        Path claudeDir = projectDir.resolve(".claude");
        if (Files.isSymbolicLink(claudeDir)) {
            throw new IOException(
                    "Cannot update MCP approval: " + claudeDir + " is a symbolic link; refusing to write through it");
        }
        if (!Files.isDirectory(claudeDir)) {
            Files.createDirectories(claudeDir);
        }

        Path realClaudeDir;
        try {
            realClaudeDir = claudeDir.toRealPath();
        } catch (IOException e) {
            throw new IOException("Cannot update MCP approval: cannot resolve " + claudeDir + ": " + e.getMessage());
        }
        if (!realClaudeDir.startsWith(realProjectDir)) {
            throw new IOException("Cannot update MCP approval: " + realClaudeDir
                                 + " resolves outside the project directory " + realProjectDir);
        }

        Path settingsLocalPath = claudeDir.resolve("settings.local.json");
        if (Files.isSymbolicLink(settingsLocalPath)) {
            throw new IOException("Cannot update MCP approval: " + settingsLocalPath
                                 + " is a symbolic link; refusing to write through it");
        }
        if (Files.exists(settingsLocalPath)) {
            Path realSettingsPath;
            try {
                realSettingsPath = settingsLocalPath.toRealPath();
            } catch (IOException e) {
                throw new IOException("Cannot update MCP approval: cannot resolve " + settingsLocalPath
                                     + ": " + e.getMessage());
            }
            if (!realSettingsPath.startsWith(realProjectDir)) {
                throw new IOException("Cannot update MCP approval: " + settingsLocalPath + " resolves to "
                                     + realSettingsPath + ", which is outside the project directory "
                                     + realProjectDir);
            }
        }
        return settingsLocalPath;
    }

    /**
     * Read the existing settings.local.json for an update.
     *
     * <p>An unparseable or non-object file aborts the operation. The previous
     * behaviour silently continued with an empty object and then overwrote the file
     * with two keys, destroying permissions/hooks/env without a trace in the UI.
     *
     * @throws IOException if the file cannot be read or parsed; the file is left untouched
     */
    private static JsonObject readSettingsLocalForUpdate(Path settingsLocalPath) throws IOException {
        try (FileReader reader = new FileReader(settingsLocalPath.toFile(), StandardCharsets.UTF_8)) {
            JsonElement parsed = JsonParser.parseReader(reader);
            if (parsed == null || !parsed.isJsonObject()) {
                throw new IOException(settingsLocalPath
                        + " does not contain a JSON object; refusing to overwrite it");
            }
            return parsed.getAsJsonObject();
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("Failed to parse " + settingsLocalPath
                                 + "; leaving it unchanged: " + e.getMessage());
        }
    }

    /**
     * Write the settings via a temp file in the same directory and an atomic move.
     *
     * <p>Re-checks the symlink guard immediately before the move so the window
     * between the earlier {@code exists()} check and the write cannot be used to
     * redirect the write to another file.
     */
    private void writeSettingsLocalAtomically(Path settingsLocalPath, JsonObject settings) throws IOException {
        Path directory = settingsLocalPath.getParent();
        Path tempFile = Files.createTempFile(directory, "settings.local.json.", ".tmp");
        try {
            try (FileWriter writer = new FileWriter(tempFile.toFile(), StandardCharsets.UTF_8)) {
                gson.toJson(settings, writer);
                writer.flush();
            }
            if (Files.isSymbolicLink(settingsLocalPath)) {
                throw new IOException("Cannot update MCP approval: " + settingsLocalPath
                                     + " became a symbolic link; refusing to write through it");
            }
            try {
                Files.move(tempFile, settingsLocalPath,
                        StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                // Windows and some network filesystems cannot do an atomic move.
                LOG.warn("[McpServerManager] ATOMIC_MOVE is not supported for " + settingsLocalPath
                         + ", falling back to a replacing move: " + e.getMessage());
                Files.move(tempFile, settingsLocalPath, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(tempFile);
        }
    }

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
                        // Fingerprint the raw entry before it is wrapped/annotated, so
                        // an approval is bound to the spec that actually gets executed.
                        String fingerprint = fingerprintOfServerSpec(serverElem.getAsJsonObject());
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

                        // Approval state for the project-scoped .mcp.json supply-chain gate,
                        // resolved from TRUSTED sources only (user settings.json, managed
                        // settings, and the project's own git-untracked settings.local.json —
                        // NOT the committed .claude/settings.json the repo can ship).
                        ProjectMcpApproval approval = resolveProjectMcpApproval(serverId, projectPath, fingerprint);
                        server.addProperty("approvalStatus", approval.getStatus());
                        // Whether git CONFIRMED the trust behind that approval. False when the
                        // approval rests on a project-local file in a directory that is not a
                        // git repository, and false when the gate granted nothing at all. The
                        // UI has to show this rather than presenting it as a plain approval.
                        server.addProperty(KEY_TRUST_VERIFIED, approval.isTrustVerified());

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
            pruneDisabledMcpServer(projectConfig, serverId);

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

    private void pruneDisabledMcpServer(JsonObject config, String serverId) {
        if (config == null
                || !config.has("disabledMcpServers")
                || !config.get("disabledMcpServers").isJsonArray()) {
            return;
        }
        JsonArray arr = config.getAsJsonArray("disabledMcpServers");
        JsonArray filtered = new JsonArray();
        boolean changed = false;
        for (JsonElement el : arr) {
            if (el.isJsonPrimitive() && serverId.equals(el.getAsString())) {
                changed = true;
                continue;
            }
            filtered.add(el);
        }
        if (changed) {
            config.add("disabledMcpServers", filtered);
        }
    }
}

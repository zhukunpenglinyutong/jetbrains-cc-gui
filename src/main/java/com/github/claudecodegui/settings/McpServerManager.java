package com.github.claudecodegui.settings;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.util.SafeJsonFileOps;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * MCP Server Manager.
 * Manages MCP server configurations.
 *
 * <p>{@code ~/.claude.json} is the primary store and is shared with the Claude
 * CLI, which rewrites the whole file from its own in-memory snapshot at
 * arbitrary times. Every write here therefore runs inside an advisory lock,
 * re-applies its intent to the freshest content, and only replaces the file
 * when its content fingerprint is unchanged since the read. When the primary
 * file exists it is authoritative: failures are reported to the caller instead
 * of being silently redirected to the legacy {@code ~/.codemoss/config.json}.
 */
public class McpServerManager {
    private static final Logger LOG = Logger.getInstance(McpServerManager.class);

    /** Lock wait before the operation fails (ms). */
    private static final long LOCK_TIMEOUT_MS = 2_000;
    /** Read attempts when another process may be mid-write. */
    private static final int READ_ATTEMPTS = 3;
    /** Delay between read attempts (ms). */
    private static final long READ_RETRY_DELAY_MS = 100;
    /** Read/re-apply rounds for one mutation before it fails explicitly. */
    private static final int MUTATION_ATTEMPTS = 3;
    /** Fields the UI owns on a server entry; everything else moves into its {@code server} spec. */
    private static final Set<String> SERVER_UI_FIELDS = Set.of("id", "name", "enabled", "apps", "server");

    private final Gson gson;
    private final Function<Void, JsonObject> configReader;
    private final Consumer<JsonObject> configWriter;
    private final ClaudeSettingsManager claudeSettingsManager;

    public McpServerManager(
            Gson gson,
            Function<Void, JsonObject> configReader,
            Consumer<JsonObject> configWriter,
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
     *
     * <p>Source priority is explicit:
     * <ul>
     *   <li>{@code ~/.claude.json} missing → legacy {@code ~/.codemoss/config.json} (existing compatibility path);</li>
     *   <li>{@code ~/.claude.json} readable → authoritative, even when it has no
     *       {@code mcpServers} key (that means "no servers", not "look somewhere else" —
     *       consulting a secondary store here would resurrect servers the user deleted);</li>
     *   <li>{@code ~/.claude.json} unreadable → the plugin backup is shown for diagnosis only
     *       (read-only), and an error is raised when no backup is usable so the UI does not
     *       render an empty list that looks like data loss.</li>
     * </ul>
     *
     * @param projectPath the project path, used to read project-level MCP configuration
     */
    public List<JsonObject> getMcpServersWithProjectPath(String projectPath) throws IOException {
        Path claudeJsonPath = claudeJsonPath();

        if (!Files.exists(claudeJsonPath)) {
            return readFromCodemossConfig();
        }

        JsonObject claudeJson = SafeJsonFileOps.readJsonObject(claudeJsonPath, READ_ATTEMPTS, READ_RETRY_DELAY_MS);
        if (claudeJson == null) {
            // The live file exists but cannot be parsed. Return the last known
            // good copy for display only: reading must never write the backup
            // back over a file the CLI may be updating right now.
            claudeJson = SafeJsonFileOps.readJsonObject(
                    SafeJsonFileOps.backupPathOf(claudeJsonPath), 2, READ_RETRY_DELAY_MS);
            if (claudeJson == null) {
                throw new IOException("~/.claude.json exists but could not be parsed, and no usable backup is available;"
                        + " make sure it is readable and holds a valid JSON object");
            }
            LOG.warn("[McpServerManager] ~/.claude.json is unreadable — showing the last known good copy from "
                    + SafeJsonFileOps.BACKUP_SUFFIX + " (the live file is left untouched)");
        }

        List<JsonObject> servers = buildServerList(claudeJson, projectPath);
        if (servers.isEmpty() && !claudeJson.has("mcpServers")) {
            LOG.info("[McpServerManager] ~/.claude.json has no mcpServers entry — treating it as 'no servers'"
                    + " (the legacy ~/.codemoss/config.json is not consulted while ~/.claude.json exists)");
        }
        return servers;
    }

    /**
     * Build the UI list from a parsed ~/.claude.json document.
     *
     * @param claudeJson  the parsed document
     * @param projectPath optional project path whose mcpServers override global ones
     * @return the servers, with id/name/server/enabled fields filled in
     */
    private List<JsonObject> buildServerList(JsonObject claudeJson, String projectPath) {
        List<JsonObject> result = new ArrayList<>();
        if (!claudeJson.has("mcpServers") || !claudeJson.get("mcpServers").isJsonObject()) {
            return result;
        }

        JsonObject mergedServers = new JsonObject();
        JsonObject globalMcpServers = claudeJson.getAsJsonObject("mcpServers");
        for (String key : globalMcpServers.keySet()) {
            mergedServers.add(key, globalMcpServers.get(key));
        }

        if (projectPath != null && claudeJson.has("projects") && claudeJson.get("projects").isJsonObject()) {
            JsonObject projects = claudeJson.getAsJsonObject("projects");
            if (projects.has(projectPath) && projects.get(projectPath).isJsonObject()) {
                JsonObject projectConfig = projects.getAsJsonObject(projectPath);
                if (projectConfig.has("mcpServers") && projectConfig.get("mcpServers").isJsonObject()) {
                    JsonObject projectMcpServers = projectConfig.getAsJsonObject("mcpServers");
                    for (String key : projectMcpServers.keySet()) {
                        mergedServers.add(key, projectMcpServers.get(key));
                    }
                    LOG.info("[McpServerManager] Merged project-level MCP servers from: " + projectPath);
                }
            }
        }

        Set<String> disabledServers = collectDisabledServers(claudeJson, projectPath);

        for (String serverId : mergedServers.keySet()) {
            JsonElement serverElem = mergedServers.get(serverId);
            if (!serverElem.isJsonObject()) {
                continue;
            }
            JsonObject server = serverElem.getAsJsonObject();
            if (!server.has("id")) {
                server.addProperty("id", serverId);
            }
            if (!server.has("name")) {
                server.addProperty("name", serverId);
            }
            if (!server.has("server")) {
                JsonObject serverSpec = new JsonObject();
                for (String key : server.keySet()) {
                    if (!SERVER_UI_FIELDS.contains(key)) {
                        serverSpec.add(key, server.get(key));
                    }
                }
                server.add("server", serverSpec);
            }
            server.addProperty("enabled", !disabledServers.contains(serverId));
            result.add(server);
        }

        LOG.info("[McpServerManager] Loaded " + result.size()
                + " MCP servers from ~/.claude.json (disabled: " + disabledServers.size() + ")");
        return result;
    }

    /**
     * Collect the disabled server ids from the global and project-level lists.
     *
     * @param claudeJson  the parsed document
     * @param projectPath optional project path
     * @return the merged set of disabled ids
     */
    private static Set<String> collectDisabledServers(JsonObject claudeJson, String projectPath) {
        Set<String> disabledServers = new HashSet<>();
        addAllStrings(claudeJson, "disabledMcpServers", disabledServers);

        if (projectPath != null && claudeJson.has("projects") && claudeJson.get("projects").isJsonObject()) {
            JsonObject projects = claudeJson.getAsJsonObject("projects");
            if (projects.has(projectPath) && projects.get(projectPath).isJsonObject()) {
                JsonObject projectConfig = projects.getAsJsonObject(projectPath);
                addAllStrings(projectConfig, "disabledMcpServers", disabledServers);
                LOG.info("[McpServerManager] Merged project-level disabled servers from: " + projectPath);
            }
        }
        return disabledServers;
    }

    /**
     * Add the string elements of {@code owner[key]} to {@code target}.
     *
     * @param owner  the object holding the array
     * @param key    the array property name
     * @param target the set to fill
     */
    private static void addAllStrings(JsonObject owner, String key, Set<String> target) {
        if (!owner.has(key) || !owner.get(key).isJsonArray()) {
            return;
        }
        for (JsonElement elem : owner.getAsJsonArray(key)) {
            if (elem.isJsonPrimitive()) {
                target.add(elem.getAsString());
            }
        }
    }

    /**
     * Read the legacy {@code ~/.codemoss/config.json} server array.
     *
     * @return the servers found there (possibly empty)
     */
    private List<JsonObject> readFromCodemossConfig() {
        List<JsonObject> result = new ArrayList<>();
        JsonObject config = configReader.apply(null);
        if (config != null && config.has("mcpServers") && config.get("mcpServers").isJsonArray()) {
            for (JsonElement elem : config.getAsJsonArray("mcpServers")) {
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
     * falling back to ~/.codemoss/config.json only when that file does not exist.
     */
    public void upsertMcpServer(JsonObject server) throws IOException {
        upsertMcpServer(server, null);
    }

    /**
     * Upsert (update or insert) an MCP server (with project path support).
     *
     * <p>The update is planned against the freshest content on every attempt and
     * only replaces the file when nothing else wrote to it in between, so an
     * unrelated field or server added by another writer (the CLI, another IDE
     * window) survives.
     *
     * @param projectPath the project path, used to update project-level disabledMcpServers (Claude CLI merges global and project-level disabled lists)
     */
    public void upsertMcpServer(JsonObject server, String projectPath) throws IOException {
        if (!server.has("id")) {
            throw new IllegalArgumentException("Server must have an id");
        }
        String serverId = server.get("id").getAsString();
        boolean isEnabled = !server.has("enabled") || server.get("enabled").getAsBoolean();

        Path claudeJsonPath = claudeJsonPath();
        if (!Files.exists(claudeJsonPath)) {
            // Legacy installs: the CLI never created its store, keep using codemoss config.
            upsertIntoCodemossConfig(server, serverId);
            return;
        }

        try {
            SafeJsonFileOps.withLock(lockPath(claudeJsonPath), LOCK_TIMEOUT_MS,
                    () -> SafeJsonFileOps.mutateJsonAtomically(claudeJsonPath, MUTATION_ATTEMPTS, READ_RETRY_DELAY_MS,
                            current -> {
                                JsonObject document = current != null ? current : new JsonObject();
                                applyUpsert(document, server, serverId, isEnabled, projectPath);
                                return writer -> gson.toJson(document, writer);
                            }));
        } catch (IOException e) {
            // The primary file exists: never fork the write into the legacy
            // store, which would hide the failure and split the config.
            throw new IOException("Failed to update ~/.claude.json: " + e.getMessage(), e);
        }

        LOG.info("[McpServerManager] Upserted MCP server in ~/.claude.json: " + serverId
                + " (enabled: " + isEnabled + ", projectPath: " + (projectPath != null ? projectPath : "(global)") + ")");
        syncAfterMutation(false);
    }

    /**
     * Apply one upsert to an in-memory ~/.claude.json document.
     *
     * @param document    the document read from disk (modified in place)
     * @param server      the server payload from the webview
     * @param serverId    the target server id
     * @param isEnabled   whether the server should end up enabled
     * @param projectPath optional project path for the project-level disabled list
     */
    private static void applyUpsert(JsonObject document, JsonObject server, String serverId,
                                    boolean isEnabled, String projectPath) {
        JsonObject mcpServers = ensureObject(document, "mcpServers");

        JsonObject serverSpec;
        if (server.has("server") && server.get("server").isJsonObject()) {
            serverSpec = server.getAsJsonObject("server").deepCopy();
        } else {
            serverSpec = new JsonObject();
        }

        // Merge with the existing config so fields the payload omits survive.
        if (mcpServers.has(serverId) && mcpServers.get(serverId).isJsonObject()) {
            JsonObject existingSpec = mcpServers.getAsJsonObject(serverId).deepCopy();
            for (String key : serverSpec.keySet()) {
                existingSpec.add(key, serverSpec.get(key));
            }
            serverSpec = existingSpec;
        }
        mcpServers.add(serverId, serverSpec);

        // Global disabled list: a server is disabled for everyone or not at all.
        if (projectPath == null) {
            rebuildDisabledList(document, serverId, !isEnabled);
        } else if (isEnabled) {
            rebuildDisabledList(document, serverId, false);
        }

        if (projectPath != null) {
            JsonObject projects = ensureObject(document, "projects");
            JsonObject projectConfig = ensureObject(projects, projectPath);
            rebuildDisabledList(projectConfig, serverId, !isEnabled);
        }
    }

    /**
     * Replace {@code owner.disabledMcpServers} with the current entries minus
     * {@code serverId}, re-adding the id only when the server is disabled.
     *
     * @param owner    the object holding the disabled list
     * @param serverId the server id to normalise
     * @param disabled whether the server should be listed as disabled
     */
    private static void rebuildDisabledList(JsonObject owner, String serverId, boolean disabled) {
        JsonArray existing = ensureArray(owner, "disabledMcpServers");
        JsonArray rebuilt = new JsonArray();
        for (JsonElement elem : existing) {
            if (!elem.isJsonPrimitive() || !elem.getAsString().equals(serverId)) {
                rebuilt.add(elem);
            }
        }
        if (disabled) {
            rebuilt.add(serverId);
        }
        owner.add("disabledMcpServers", rebuilt);
    }

    /**
     * Delete an MCP server.
     * Prefers deleting from ~/.claude.json (standard Claude CLI location),
     * falling back to ~/.codemoss/config.json only when that file does not exist.
     *
     * @param serverId the server to delete
     * @return true when the server was found and removed
     * @throws IOException when the primary store exists but cannot be updated
     */
    public boolean deleteMcpServer(String serverId) throws IOException {
        Path claudeJsonPath = claudeJsonPath();

        if (Files.exists(claudeJsonPath)) {
            AtomicBoolean removed = new AtomicBoolean(false);
            try {
                SafeJsonFileOps.withLock(lockPath(claudeJsonPath), LOCK_TIMEOUT_MS,
                        () -> SafeJsonFileOps.mutateJsonAtomically(claudeJsonPath, MUTATION_ATTEMPTS,
                                READ_RETRY_DELAY_MS, current -> {
                                    if (!hasServer(current, serverId)) {
                                        // Nothing to delete (or the key is absent):
                                        // leave the file untouched instead of
                                        // rewriting it or clearing unrelated state.
                                        return null;
                                    }
                                    JsonObject mcpServers = current.getAsJsonObject("mcpServers");
                                    mcpServers.remove(serverId);
                                    removeFromDisabledList(current, serverId);
                                    removed.set(true);
                                    return writer -> gson.toJson(current, writer);
                                }));
            } catch (IOException e) {
                throw new IOException("Failed to delete MCP server from ~/.claude.json: " + e.getMessage(), e);
            }

            if (removed.get()) {
                LOG.info("[McpServerManager] Deleted MCP server from ~/.claude.json: " + serverId);
                // allowEmptyOverwrite: the user deleted intentionally, so an
                // empty source must propagate — otherwise settings.json keeps
                // a ghost the UI no longer shows.
                syncAfterMutation(true);
                return true;
            }
        }

        return deleteFromCodemossConfig(serverId);
    }

    /**
     * @param document the parsed document (may be null)
     * @param serverId the server id to look for
     * @return true when the global mcpServers object contains that id
     */
    private static boolean hasServer(JsonObject document, String serverId) {
        return document != null
                && document.has("mcpServers")
                && document.get("mcpServers").isJsonObject()
                && document.getAsJsonObject("mcpServers").has(serverId);
    }

    /**
     * Drop {@code serverId} from the global disabled list, leaving every other entry intact.
     *
     * @param document the parsed document (modified in place)
     * @param serverId the deleted server id
     */
    private static void removeFromDisabledList(JsonObject document, String serverId) {
        if (!document.has("disabledMcpServers") || !document.get("disabledMcpServers").isJsonArray()) {
            return;
        }
        JsonArray rebuilt = new JsonArray();
        for (JsonElement elem : document.getAsJsonArray("disabledMcpServers")) {
            if (!elem.isJsonPrimitive() || !elem.getAsString().equals(serverId)) {
                rebuilt.add(elem);
            }
        }
        document.add("disabledMcpServers", rebuilt);
    }

    /**
     * Sync the MCP view of settings.json after a successful ~/.claude.json mutation.
     *
     * <p>A sync failure is logged, not escalated: the primary store is already
     * updated and reporting the whole operation as failed would invite a retry
     * that duplicates work.
     *
     * @param allowEmptyOverwrite whether an intentionally emptied source may clear settings.json
     */
    private void syncAfterMutation(boolean allowEmptyOverwrite) {
        try {
            claudeSettingsManager.syncMcpToClaudeSettings(allowEmptyOverwrite);
        } catch (Exception syncError) {
            LOG.warn("[McpServerManager] Failed to sync MCP to settings.json: " + syncError.getMessage());
        }
    }

    /**
     * Legacy path: upsert into {@code ~/.codemoss/config.json}.
     *
     * @param server   the server payload
     * @param serverId its id
     */
    private void upsertIntoCodemossConfig(JsonObject server, String serverId) {
        JsonObject config = configReader.apply(null);
        if (config == null) {
            config = new JsonObject();
        }
        JsonArray servers = ensureArray(config, "mcpServers");

        boolean found = false;
        for (int i = 0; i < servers.size(); i++) {
            JsonElement elem = servers.get(i);
            if (elem.isJsonObject()
                    && elem.getAsJsonObject().has("id")
                    && elem.getAsJsonObject().get("id").getAsString().equals(serverId)) {
                servers.set(i, server);
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
     * Legacy path: delete from {@code ~/.codemoss/config.json}, then drop the
     * same id from settings.json.
     *
     * <p>Only that id is removed: this delete never touched ~/.claude.json, so
     * re-syncing from it (with an intentional-empty overwrite) could clear
     * unrelated servers from settings.json.
     *
     * @param serverId the server to delete
     * @return true when it was found and removed
     */
    private boolean deleteFromCodemossConfig(String serverId) {
        JsonObject config = configReader.apply(null);
        if (config == null || !config.has("mcpServers") || !config.get("mcpServers").isJsonArray()) {
            return false;
        }

        JsonArray servers = config.getAsJsonArray("mcpServers");
        JsonArray remaining = new JsonArray();
        boolean removed = false;
        for (JsonElement elem : servers) {
            if (elem.isJsonObject()
                    && elem.getAsJsonObject().has("id")
                    && elem.getAsJsonObject().get("id").getAsString().equals(serverId)) {
                removed = true;
            } else {
                remaining.add(elem);
            }
        }

        if (!removed) {
            return false;
        }
        config.add("mcpServers", remaining);
        configWriter.accept(config);
        LOG.info("[McpServerManager] Deleted MCP server from ~/.codemoss/config.json: " + serverId);
        // The deleted server may have been synced into settings.json earlier.
        try {
            claudeSettingsManager.removeMcpServerFromClaudeSettings(serverId);
        } catch (Exception syncError) {
            LOG.warn("[McpServerManager] Failed to remove " + serverId + " from settings.json: " + syncError.getMessage());
        }
        return true;
    }

    /**
     * @return the path of the shared Claude CLI config
     */
    private static Path claudeJsonPath() {
        return Paths.get(NodeDetector.resolveHomeForFileOps(), ".claude.json");
    }

    /**
     * @param target the config file the lock protects
     * @return the sidecar lock file path
     */
    private static Path lockPath(Path target) {
        return SafeJsonFileOps.sibling(target, ".ccgui-lock");
    }

    /**
     * @param owner the object holding the property
     * @param key   the property name
     * @return the object at {@code key}, replaced with a fresh one when absent or not an object
     */
    private static JsonObject ensureObject(JsonObject owner, String key) {
        JsonElement existing = owner.get(key);
        if (existing != null && existing.isJsonObject()) {
            return existing.getAsJsonObject();
        }
        JsonObject created = new JsonObject();
        owner.add(key, created);
        return created;
    }

    /**
     * @param owner the object holding the property
     * @param key   the property name
     * @return the array at {@code key}, replaced with a fresh one when absent or not an array
     */
    private static JsonArray ensureArray(JsonObject owner, String key) {
        JsonElement existing = owner.get(key);
        if (existing != null && existing.isJsonArray()) {
            return existing.getAsJsonArray();
        }
        JsonArray created = new JsonArray();
        owner.add(key, created);
        return created;
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
}

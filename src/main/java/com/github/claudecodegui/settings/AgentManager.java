package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.AgentFields;
import com.github.claudecodegui.util.LogSanitizer;
import com.github.claudecodegui.model.ConflictStrategy;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.*;

/**
 * Agent Manager.
 * Manages agent configurations (agent.json).
 */
public class AgentManager {
    private static final Logger LOG = Logger.getInstance(AgentManager.class);

    private final Gson gson;
    private final ConfigPathManager pathManager;

    public AgentManager(Gson gson, ConfigPathManager pathManager) {
        this.gson = gson;
        this.pathManager = pathManager;
    }

    /**
     * Read the agent.json file.
     */
    public JsonObject readAgentConfig() throws IOException {
        Path agentPath = pathManager.getAgentFilePath();
        File agentFile = agentPath.toFile();

        if (!agentFile.exists()) {
            // Return an empty config
            JsonObject config = new JsonObject();
            config.add("agents", new JsonObject());
            return config;
        }

        try (FileReader reader = new FileReader(agentFile, StandardCharsets.UTF_8)) {
            JsonObject config = JsonParser.parseReader(reader).getAsJsonObject();
            JsonElement agentsElement = config.get("agents");
            if (agentsElement == null || !agentsElement.isJsonObject()) {
                if (agentsElement != null) {
                    LOG.warn("[AgentManager] Ignoring invalid agents node in agent.json");
                }
                config.add("agents", new JsonObject());
            }
            return config;
        } catch (Exception e) {
            LOG.warn("[AgentManager] Failed to read agent.json: "
                    + e.getClass().getSimpleName());
            JsonObject config = new JsonObject();
            config.add("agents", new JsonObject());
            return config;
        }
    }

    /**
     * Write the agent.json file.
     *
     * <p>Delegates to the atomic path rather than truncating in place. Two
     * reasons, both of which bite in real use rather than in theory:
     *
     * <ul>
     *   <li>A {@code FileWriter} on the real path empties the store before the
     *       first byte is written, so a failure mid-serialization leaves the
     *       user with an empty {@code agent.json} and no way back.</li>
     *   <li>Opening the path for writing follows a symbolic link. Symlinking
     *       {@code agent.json} into a dotfiles repository is ordinary practice,
     *       and the old path would rewrite whatever the link points at, without
     *       a backup and without being atomic. An atomic rename replaces the
     *       link itself, which is what the user meant.</li>
     * </ul>
     */
    public void writeAgentConfig(JsonObject config) throws IOException {
        writeAgentConfigAtomically(config);
    }

    /**
     * Get all agents.
     * Sorted by creation time in descending order (newest first).
     */
    public List<JsonObject> getAgents() throws IOException {
        List<JsonObject> result = new ArrayList<>();
        JsonObject config = readAgentConfig();

        JsonObject agents = config.getAsJsonObject("agents");
        for (Map.Entry<String, JsonElement> entry : agents.entrySet()) {
            String key = entry.getKey();
            JsonElement value = entry.getValue();
            if (!value.isJsonObject()) {
                LOG.warn("[AgentManager] Ignoring non-object agent entry: "
                    + LogSanitizer.sanitize(key));
                continue;
            }

            JsonObject agent = value.getAsJsonObject();
            // Ensure ID exists
            if (!agent.has("id")) {
                agent.addProperty("id", key);
            }
            // Stamp discovery metadata on the in-memory view only. Store entries
            // are never written back to disk with these fields, so a legacy
            // 4-field entry still round-trips byte-for-byte.
            applyStoreDefaults(agent);
            result.add(agent);
        }

        // Sort by creation time descending (newest first)
        result.sort((a, b) -> Long.compare(getCreatedAt(b), getCreatedAt(a)));

        LOG.info("[AgentManager] Loaded " + result.size() + " agents from agent.json");
        return result;
    }

    /**
     * Add an agent.
     */
    public void addAgent(JsonObject agent) throws IOException {
        if (!agent.has("id")) {
            throw new IllegalArgumentException("Agent must have an id");
        }

        JsonObject config = readAgentConfig();
        JsonObject agents = config.getAsJsonObject("agents");
        String id = agent.get("id").getAsString();

        // Check if the ID already exists
        if (agents.has(id)) {
            throw new IllegalArgumentException("Agent with id '" + id + "' already exists");
        }

        // Add creation timestamp
        if (!agent.has("createdAt")) {
            agent.addProperty("createdAt", System.currentTimeMillis());
        }

        // Add the agent
        agents.add(id, agent);

        writeAgentConfig(config);
        LOG.info("[AgentManager] Added agent: " + LogSanitizer.sanitize(id));
    }

    /**
     * Update an agent.
     */
    public void updateAgent(String id, JsonObject updates) throws IOException {
        JsonObject config = readAgentConfig();
        JsonObject agents = config.getAsJsonObject("agents");

        JsonObject agent = getAgentObject(agents, id);
        if (agent == null) {
            throw new IllegalArgumentException("Agent with id '" + id + "' not found");
        }

        // Merge updates
        for (String key : updates.keySet()) {
            // Modification of id and createdAt is not allowed
            if (key.equals("id") || key.equals("createdAt")) {
                continue;
            }

            if (updates.get(key).isJsonNull()) {
                agent.remove(key);
            } else {
                agent.add(key, updates.get(key));
            }
        }

        writeAgentConfig(config);
        LOG.info("[AgentManager] Updated agent: " + LogSanitizer.sanitize(id));
    }

    /**
     * Delete an agent.
     */
    public boolean deleteAgent(String id) throws IOException {
        JsonObject config = readAgentConfig();
        JsonObject agents = config.getAsJsonObject("agents");

        if (!agents.has(id)) {
            LOG.info("[AgentManager] Agent not found: " + id);
            return false;
        }

        // Delete the agent
        agents.remove(id);

        writeAgentConfig(config);
        LOG.info("[AgentManager] Deleted agent: " + LogSanitizer.sanitize(id));
        return true;
    }

    /**
     * Get a single agent by ID.
     */
    public JsonObject getAgent(String id) throws IOException {
        JsonObject config = readAgentConfig();
        JsonObject agents = config.getAsJsonObject("agents");

        JsonObject agent = getAgentObject(agents, id);
        if (agent == null) {
            return null;
        }
        if (!agent.has("id")) {
            agent.addProperty("id", id);
        }

        return agent;
    }

    private JsonObject getAgentObject(JsonObject agents, String id) {
        JsonElement value = agents.get(id);
        return value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
    }

    /**
     * Fill in the discovery metadata that every store entry implicitly has.
     *
     * <p>Store agents come from the plugin's own ~/.codemoss/agent.json, so their
     * scope is "store", their source is "store", they are editable (not
     * read-only) and they have no file path. Anything already present is left
     * alone, so a caller that assigns an explicit scope keeps it.
     *
     * <p>This only enriches the in-memory JSON handed to the webview; the fields
     * are not persisted. That keeps legacy 4-field files unchanged on disk while
     * still giving the UI the metadata it needs to render a source badge.
     *
     * @param agent the agent object to enrich
     */
    private void applyStoreDefaults(JsonObject agent) {
        if (!agent.has("scope")) {
            agent.addProperty("scope", AgentFields.SCOPE_STORE);
        }
        if (!agent.has("source")) {
            agent.addProperty("source", AgentFields.SCOPE_STORE);
        }
        if (!agent.has("readOnly")) {
            // Store entries are the editable copy; discovered file-backed agents
            // are the read-only ones.
            agent.addProperty("readOnly", false);
        }
    }

    private long getCreatedAt(JsonObject agent) {
        JsonElement value = agent.get("createdAt");
        if (value == null || !value.isJsonPrimitive()) {
            return 0L;
        }
        try {
            return value.getAsLong();
        } catch (NumberFormatException e) {
            return 0L;
        }
    }

    /**
     * Get the currently selected agent ID.
     */
    public String getSelectedAgentId() throws IOException {
        JsonObject config = readAgentConfig();
        if (config.has("selectedAgentId") && !config.get("selectedAgentId").isJsonNull()) {
            return config.get("selectedAgentId").getAsString();
        }
        return null;
    }

    /**
     * Set the currently selected agent ID.
     */
    public void setSelectedAgentId(String agentId) throws IOException {
        JsonObject config = readAgentConfig();
        if (agentId == null || agentId.isEmpty()) {
            config.remove("selectedAgentId");
        } else {
            config.addProperty("selectedAgentId", agentId);
        }
        writeAgentConfig(config);
        LOG.info("[AgentManager] Set selected agent: " + agentId);
    }

    /**
     * Validate an agent object for import.
     * @param agent The agent to validate
     * @return Validation error message, or null if valid
     */
    public String validateAgent(JsonObject agent) {
        if (agent == null) {
            return "Agent data is null";
        }

        if (!agent.has("id") || agent.get("id").isJsonNull()) {
            return "Missing required field: id";
        }

        if (!agent.has("name") || agent.get("name").isJsonNull()) {
            return "Missing required field: name";
        }

        // Name rules follow the Claude Code subagent specification: no length
        // limit, and only ':' is reserved (it marks plugin-scoped ids such as
        // "my-plugin:reviewer", which Claude Code refuses to load). The former
        // 1-20 character cap rejected 16 real agents on the developer's machine,
        // so it was removed; names that merely deviate from the hyphen-case
        // convention stay valid and are flagged by AgentFields instead.
        String name = agent.get("name").getAsString();
        if (!AgentFields.isValidName(name)) {
            return "Agent name must not be empty or contain ':'";
        }

        if (agent.has("prompt") && !agent.get("prompt").isJsonNull()) {
            String prompt = agent.get("prompt").getAsString();
            if (prompt.length() > 100000) {
                return "Agent prompt must be less than 100,000 characters";
            }
        }

        return null;
    }

    /**
     * Detect conflicts with existing agents.
     * @param agentsToImport List of agents to check
     * @return Set of IDs that conflict with existing agents
     */
    public Set<String> detectConflicts(List<JsonObject> agentsToImport) throws IOException {
        Set<String> conflicts = new HashSet<>();
        JsonObject config = readAgentConfig();
        JsonObject existingAgents = config.getAsJsonObject("agents");

        for (JsonObject agent : agentsToImport) {
            if (agent.has("id")) {
                String id = agent.get("id").getAsString();
                if (existingAgents.has(id)) {
                    conflicts.add(id);
                }
            }
        }

        return conflicts;
    }

    /**
     * Generate a unique ID based on a base ID by appending a suffix.
     * @param baseId The base ID to use
     * @param existingItems The existing agents JsonObject to check against
     * @return A unique ID that doesn't conflict with existing agents
     */
    public String generateUniqueId(String baseId, JsonObject existingItems) {
        String uniqueId = baseId;
        int suffix = 1;

        while (existingItems.has(uniqueId)) {
            uniqueId = baseId + "-" + suffix;
            suffix++;
        }

        return uniqueId;
    }

    /**
     * Batch import agents with conflict resolution strategy.
     * @param agentsToImport List of agents to import
     * @param strategy Conflict resolution strategy
     * @return Map with import statistics (imported, skipped, updated, errors)
     */
    public Map<String, Object> batchImportAgents(List<JsonObject> agentsToImport, ConflictStrategy strategy) throws IOException {
        Map<String, Object> result = new HashMap<>();
        int imported = 0;
        int skipped = 0;
        int updated = 0;
        List<String> errors = new ArrayList<>();

        JsonObject config = readAgentConfig();
        JsonObject agents = config.getAsJsonObject("agents");
        Set<String> conflicts = detectConflicts(agentsToImport);

        for (JsonObject agent : agentsToImport) {
            try {
                String validationError = validateAgent(agent);
                if (validationError != null) {
                    errors.add("Validation failed: " + validationError);
                    skipped++;
                    continue;
                }

                String id = agent.get("id").getAsString();
                boolean hasConflict = conflicts.contains(id);

                if (hasConflict) {
                    switch (strategy) {
                        case SKIP:
                            LOG.info("[AgentManager] Skipping conflicting agent: " + id);
                            skipped++;
                            continue;

                        case OVERWRITE:
                            LOG.info("[AgentManager] Overwriting existing agent: " + id);
                            agents.add(id, agent);
                            updated++;
                            break;

                        case DUPLICATE:
                            String newId = generateUniqueId(id, agents);
                            LOG.info("[AgentManager] Creating duplicate with new ID: " + newId);
                            JsonObject duplicatedAgent = agent.deepCopy();
                            duplicatedAgent.addProperty("id", newId);
                            if (!duplicatedAgent.has("createdAt")) {
                                duplicatedAgent.addProperty("createdAt", System.currentTimeMillis());
                            }
                            agents.add(newId, duplicatedAgent);
                            imported++;
                            break;
                    }
                } else {
                    if (!agent.has("createdAt")) {
                        agent.addProperty("createdAt", System.currentTimeMillis());
                    }
                    agents.add(id, agent);
                    imported++;
                }
            } catch (Exception e) {
                String errorMsg = "Failed to import agent: " + e.getMessage();
                LOG.warn("[AgentManager] " + errorMsg);
                errors.add(errorMsg);
                skipped++;
            }
        }

        writeAgentConfig(config);
        LOG.info(String.format("[AgentManager] Batch import completed: %d imported, %d updated, %d skipped",
                imported, updated, skipped));

        result.put("imported", imported);
        result.put("updated", updated);
        result.put("skipped", skipped);
        result.put("errors", errors);
        result.put("success", errors.isEmpty());

        return result;
    }

    /**
     * Replace agent.json with the given content via a temp file and a rename.
     *
     * <p>Two properties this method actually has, both structural:
     *
     * <ul>
     *   <li>A reader never observes a half-written store. The bytes are staged
     *       in a sibling temp file and the target is swapped by one rename, so
     *       there is no instant at which {@code agent.json} is partial.</li>
     *   <li>The write does not follow a symbolic link. Opening the target for
     *       writing would rewrite whatever the link points at — and a symlink
     *       into a dotfiles repository is ordinary practice. A rename replaces
     *       the link itself, which is what the user meant.</li>
     * </ul>
     *
     * <p>Staged in the target's own directory so the rename stays within one
     * filesystem; a temp file elsewhere would silently degrade to a copy.
     *
     * @param config the configuration to serialize
     * @throws IOException when the write fails; the store is left as it was
     */
    private void writeAgentConfigAtomically(JsonObject config) throws IOException {
        pathManager.ensureConfigDirectory();
        Path target = pathManager.getAgentFilePath();
        Path parent = target.getParent();
        if (parent == null) {
            // A parent is required to stage the temporary file in. This branch
            // is unreachable — getAgentFilePath() never returns a parentless
            // path — and the in-place writer it used to fall back to carried
            // the two defects this method exists to remove: truncating the
            // target before the first byte was written, and following a
            // symbolic link. Failing loudly beats reintroducing either.
            throw new IOException("Cannot write agent.json atomically: "
                    + LogSanitizer.sanitize(target.toString()) + " has no parent directory");
        }

        String fileName = target.getFileName() != null ? target.getFileName().toString() : "agent.json";
        Path temp = Files.createTempFile(parent, fileName + "-", ".tmp");
        try {
            Files.writeString(temp, gson.toJson(config), StandardCharsets.UTF_8);
            // Before the rename, so the store's permissions do not depend on the
            // umask and stay consistent with the backup's.
            hardenFilePermissions(temp);
            try {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                // Some filesystems (and Windows across volumes) cannot do this.
                // The rename is still a single operation, just not guaranteed
                // crash-atomic, so the backup remains the real safety net.
                LOG.warn("[AgentManager] Atomic move unavailable for agent.json, falling back: " + e.getMessage());
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            try {
                Files.deleteIfExists(temp);
            } catch (IOException e) {
                LOG.debug("[AgentManager] Could not remove temp file "
                    + LogSanitizer.sanitize(temp.toString()) + ": "
                    + e.getClass().getSimpleName());
            }
        }
    }

    /**
     * Best-effort restrict a file to owner read/write (0600). No-op on
     * non-POSIX filesystems, where the per-user home directory ACL applies.
     */
    private static void hardenFilePermissions(Path path) {
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException e) {
            LOG.debug("[AgentManager] Could not set 0600 on "
                    + LogSanitizer.sanitize(path.toString()) + ": "
                    + e.getClass().getSimpleName());
        }
    }

}

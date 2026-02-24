package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.ConflictStrategy;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.file.Path;
import java.util.*;
import java.util.regex.Pattern;

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

        try (FileReader reader = new FileReader(agentFile)) {
            JsonObject config = JsonParser.parseReader(reader).getAsJsonObject();
            // Ensure the agents node exists
            if (!config.has("agents")) {
                config.add("agents", new JsonObject());
            }
            return config;
        } catch (Exception e) {
            LOG.warn("[AgentManager] Failed to read agent.json: " + e.getMessage());
            JsonObject config = new JsonObject();
            config.add("agents", new JsonObject());
            return config;
        }
    }

    /**
     * Write the agent.json file.
     */
    public void writeAgentConfig(JsonObject config) throws IOException {
        pathManager.ensureConfigDirectory();

        Path agentPath = pathManager.getAgentFilePath();
        try (FileWriter writer = new FileWriter(agentPath.toFile())) {
            gson.toJson(config, writer);
            LOG.info("[AgentManager] Successfully wrote agent.json");
        } catch (Exception e) {
            LOG.warn("[AgentManager] Failed to write agent.json: " + e.getMessage());
            throw e;
        }
    }

    /**
     * Get all agents.
     * Sorted by creation time in descending order (newest first).
     */
    public List<JsonObject> getAgents() throws IOException {
        List<JsonObject> result = new ArrayList<>();
        JsonObject config = readAgentConfig();

        JsonObject agents = config.getAsJsonObject("agents");
        for (String key : agents.keySet()) {
            JsonObject agent = agents.getAsJsonObject(key);
            // Ensure ID exists
            if (!agent.has("id")) {
                agent.addProperty("id", key);
            }
            result.add(agent);
        }

        // Sort by creation time descending (newest first)
        result.sort((a, b) -> {
            long timeA = a.has("createdAt") ? a.get("createdAt").getAsLong() : 0;
            long timeB = b.has("createdAt") ? b.get("createdAt").getAsLong() : 0;
            return Long.compare(timeB, timeA);
        });

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
        LOG.info("[AgentManager] Added agent: " + id);
    }

    /**
     * Update an agent.
     */
    public void updateAgent(String id, JsonObject updates) throws IOException {
        JsonObject config = readAgentConfig();
        JsonObject agents = config.getAsJsonObject("agents");

        if (!agents.has(id)) {
            throw new IllegalArgumentException("Agent with id '" + id + "' not found");
        }

        JsonObject agent = agents.getAsJsonObject(id);

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
        LOG.info("[AgentManager] Updated agent: " + id);
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
        LOG.info("[AgentManager] Deleted agent: " + id);
        return true;
    }

    /**
     * Get a single agent by ID.
     */
    public JsonObject getAgent(String id) throws IOException {
        JsonObject config = readAgentConfig();
        JsonObject agents = config.getAsJsonObject("agents");

        if (!agents.has(id)) {
            return null;
        }

        JsonObject agent = agents.getAsJsonObject(id);
        if (!agent.has("id")) {
            agent.addProperty("id", id);
        }

        return agent;
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

        String name = agent.get("name").getAsString();
        if (name.isEmpty() || name.length() > 20) {
            return "Agent name must be 1-20 characters";
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
}

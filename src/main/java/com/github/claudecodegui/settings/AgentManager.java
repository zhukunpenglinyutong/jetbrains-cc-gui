package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

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
}

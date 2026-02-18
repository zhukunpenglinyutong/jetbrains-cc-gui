package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Prompt Manager.
 * Manages prompt library configuration (prompt.json).
 */
public class PromptManager {
    private static final Logger LOG = Logger.getInstance(PromptManager.class);

    /**
     * Valid prompt ID pattern: UUID format or numeric timestamp string.
     * Rejects IDs containing path separators, whitespace, or special characters.
     */
    private static final Pattern VALID_ID_PATTERN = Pattern.compile("^[a-zA-Z0-9\\-]{1,64}$");

    private final Gson gson;
    private final ConfigPathManager pathManager;

    public PromptManager(Gson gson, ConfigPathManager pathManager) {
        this.gson = gson;
        this.pathManager = pathManager;
    }

    /**
     * Read the prompt.json file.
     */
    public JsonObject readPromptConfig() throws IOException {
        Path promptPath = pathManager.getPromptFilePath();

        if (!Files.exists(promptPath)) {
            // Return an empty config
            JsonObject config = new JsonObject();
            config.add("prompts", new JsonObject());
            return config;
        }

        try (BufferedReader reader = Files.newBufferedReader(promptPath, StandardCharsets.UTF_8)) {
            JsonObject config = JsonParser.parseReader(reader).getAsJsonObject();
            // Ensure the prompts node exists
            if (!config.has("prompts")) {
                config.add("prompts", new JsonObject());
            }
            return config;
        } catch (Exception e) {
            LOG.warn("[PromptManager] Failed to read prompt.json: " + e.getMessage());
            JsonObject config = new JsonObject();
            config.add("prompts", new JsonObject());
            return config;
        }
    }

    /**
     * Write the prompt.json file.
     */
    public void writePromptConfig(JsonObject config) throws IOException {
        pathManager.ensureConfigDirectory();

        Path promptPath = pathManager.getPromptFilePath();
        try (BufferedWriter writer = Files.newBufferedWriter(promptPath, StandardCharsets.UTF_8)) {
            gson.toJson(config, writer);
            LOG.debug("[PromptManager] Successfully wrote prompt.json");
        } catch (Exception e) {
            LOG.warn("[PromptManager] Failed to write prompt.json: " + e.getMessage());
            throw e;
        }
    }

    /**
     * Get all prompts.
     * Sorted by creation time in descending order (newest first).
     */
    public List<JsonObject> getPrompts() throws IOException {
        List<JsonObject> result = new ArrayList<>();
        JsonObject config = readPromptConfig();

        JsonObject prompts = config.getAsJsonObject("prompts");
        for (String key : prompts.keySet()) {
            JsonObject prompt = prompts.getAsJsonObject(key);
            // Ensure ID exists
            if (!prompt.has("id")) {
                prompt.addProperty("id", key);
            }
            result.add(prompt);
        }

        // Sort by creation time descending (newest first)
        result.sort((a, b) -> {
            long timeA = a.has("createdAt") ? a.get("createdAt").getAsLong() : 0;
            long timeB = b.has("createdAt") ? b.get("createdAt").getAsLong() : 0;
            return Long.compare(timeB, timeA);
        });

        LOG.debug("[PromptManager] Loaded " + result.size() + " prompts from prompt.json");
        return result;
    }

    /**
     * Validate prompt ID format to prevent injection of malformed keys
     */
    private void validateId(String id) {
        if (id == null || id.isEmpty()) {
            throw new IllegalArgumentException("Prompt ID must not be empty");
        }
        if (!VALID_ID_PATTERN.matcher(id).matches()) {
            throw new IllegalArgumentException("Invalid prompt ID format: " + id);
        }
    }

    /**
     * Add a prompt.
     */
    public void addPrompt(JsonObject prompt) throws IOException {
        if (!prompt.has("id")) {
            throw new IllegalArgumentException("Prompt must have an id");
        }

        JsonObject config = readPromptConfig();
        JsonObject prompts = config.getAsJsonObject("prompts");
        String id = prompt.get("id").getAsString();
        validateId(id);

        // Check if the ID already exists
        if (prompts.has(id)) {
            throw new IllegalArgumentException("Prompt with id '" + id + "' already exists");
        }

        // Add creation timestamp
        if (!prompt.has("createdAt")) {
            prompt.addProperty("createdAt", System.currentTimeMillis());
        }

        // Add the prompt
        prompts.add(id, prompt);

        writePromptConfig(config);
        LOG.debug("[PromptManager] Added prompt: " + id);
    }

    /**
     * Update a prompt.
     */
    public void updatePrompt(String id, JsonObject updates) throws IOException {
        validateId(id);
        JsonObject config = readPromptConfig();
        JsonObject prompts = config.getAsJsonObject("prompts");

        if (!prompts.has(id)) {
            throw new IllegalArgumentException("Prompt with id '" + id + "' not found");
        }

        JsonObject prompt = prompts.getAsJsonObject(id);

        // Merge updates
        for (String key : updates.keySet()) {
            // Modification of id and createdAt is not allowed
            if (key.equals("id") || key.equals("createdAt")) {
                continue;
            }

            if (updates.get(key).isJsonNull()) {
                prompt.remove(key);
            } else {
                prompt.add(key, updates.get(key));
            }
        }

        writePromptConfig(config);
        LOG.debug("[PromptManager] Updated prompt: " + id);
    }

    /**
     * Delete a prompt.
     */
    public boolean deletePrompt(String id) throws IOException {
        validateId(id);
        JsonObject config = readPromptConfig();
        JsonObject prompts = config.getAsJsonObject("prompts");

        if (!prompts.has(id)) {
            LOG.debug("[PromptManager] Prompt not found: " + id);
            return false;
        }

        // Delete the prompt
        prompts.remove(id);

        writePromptConfig(config);
        LOG.debug("[PromptManager] Deleted prompt: " + id);
        return true;
    }

    /**
     * Get a single prompt by ID.
     */
    public JsonObject getPrompt(String id) throws IOException {
        validateId(id);
        JsonObject config = readPromptConfig();
        JsonObject prompts = config.getAsJsonObject("prompts");

        if (!prompts.has(id)) {
            return null;
        }

        JsonObject prompt = prompts.getAsJsonObject(id);
        if (!prompt.has("id")) {
            prompt.addProperty("id", id);
        }

        return prompt;
    }
}

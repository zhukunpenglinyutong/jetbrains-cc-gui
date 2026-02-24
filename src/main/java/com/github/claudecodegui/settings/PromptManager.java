package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.ConflictStrategy;
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
import java.util.*;
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

    /**
     * Validate a prompt object for import.
     * @param prompt The prompt to validate
     * @return Validation error message, or null if valid
     */
    public String validatePrompt(JsonObject prompt) {
        if (prompt == null) {
            return "Prompt data is null";
        }

        if (!prompt.has("id") || prompt.get("id").isJsonNull()) {
            return "Missing required field: id";
        }

        String id = prompt.get("id").getAsString();
        if (!VALID_ID_PATTERN.matcher(id).matches()) {
            return "Invalid prompt ID format: " + id;
        }

        if (!prompt.has("name") || prompt.get("name").isJsonNull()) {
            return "Missing required field: name";
        }

        String name = prompt.get("name").getAsString();
        if (name.isEmpty() || name.length() > 30) {
            return "Prompt name must be 1-30 characters";
        }

        if (!prompt.has("content") || prompt.get("content").isJsonNull()) {
            return "Missing required field: content";
        }

        String content = prompt.get("content").getAsString();
        if (content.isEmpty() || content.length() > 100000) {
            return "Prompt content must be 1-100,000 characters";
        }

        return null;
    }

    /**
     * Detect conflicts with existing prompts.
     * @param promptsToImport List of prompts to check
     * @return Set of IDs that conflict with existing prompts
     */
    public Set<String> detectConflicts(List<JsonObject> promptsToImport) throws IOException {
        Set<String> conflicts = new HashSet<>();
        JsonObject config = readPromptConfig();
        JsonObject existingPrompts = config.getAsJsonObject("prompts");

        for (JsonObject prompt : promptsToImport) {
            if (prompt.has("id")) {
                String id = prompt.get("id").getAsString();
                if (existingPrompts.has(id)) {
                    conflicts.add(id);
                }
            }
        }

        return conflicts;
    }

    /**
     * Generate a unique ID based on a base ID by appending a suffix.
     * @param baseId The base ID to use
     * @return A unique ID that doesn't conflict with existing prompts
     */
    public String generateUniqueId(String baseId) throws IOException {
        JsonObject config = readPromptConfig();
        JsonObject prompts = config.getAsJsonObject("prompts");

        String uniqueId = baseId;
        int suffix = 1;

        while (prompts.has(uniqueId)) {
            uniqueId = baseId + "-" + suffix;
            suffix++;
        }

        return uniqueId;
    }

    /**
     * Batch import prompts with conflict resolution strategy.
     * @param promptsToImport List of prompts to import
     * @param strategy Conflict resolution strategy
     * @return Map with import statistics (imported, skipped, updated, errors)
     */
    public Map<String, Object> batchImportPrompts(List<JsonObject> promptsToImport, ConflictStrategy strategy) throws IOException {
        Map<String, Object> result = new HashMap<>();
        int imported = 0;
        int skipped = 0;
        int updated = 0;
        List<String> errors = new ArrayList<>();

        JsonObject config = readPromptConfig();
        JsonObject prompts = config.getAsJsonObject("prompts");
        Set<String> conflicts = detectConflicts(promptsToImport);

        for (JsonObject prompt : promptsToImport) {
            try {
                String validationError = validatePrompt(prompt);
                if (validationError != null) {
                    errors.add("Validation failed: " + validationError);
                    skipped++;
                    continue;
                }

                String id = prompt.get("id").getAsString();
                boolean hasConflict = conflicts.contains(id);

                if (hasConflict) {
                    switch (strategy) {
                        case SKIP:
                            LOG.debug("[PromptManager] Skipping conflicting prompt: " + id);
                            skipped++;
                            continue;

                        case OVERWRITE:
                            LOG.debug("[PromptManager] Overwriting existing prompt: " + id);
                            prompt.addProperty("updatedAt", System.currentTimeMillis());
                            prompts.add(id, prompt);
                            updated++;
                            break;

                        case DUPLICATE:
                            String newId = generateUniqueId(id);
                            LOG.debug("[PromptManager] Creating duplicate with new ID: " + newId);
                            prompt.addProperty("id", newId);
                            if (!prompt.has("createdAt")) {
                                prompt.addProperty("createdAt", System.currentTimeMillis());
                            }
                            prompt.addProperty("updatedAt", System.currentTimeMillis());
                            prompts.add(newId, prompt);
                            imported++;
                            break;
                    }
                } else {
                    if (!prompt.has("createdAt")) {
                        prompt.addProperty("createdAt", System.currentTimeMillis());
                    }
                    if (!prompt.has("updatedAt")) {
                        prompt.addProperty("updatedAt", System.currentTimeMillis());
                    }
                    prompts.add(id, prompt);
                    imported++;
                }
            } catch (Exception e) {
                String errorMsg = "Failed to import prompt: " + e.getMessage();
                LOG.warn("[PromptManager] " + errorMsg);
                errors.add(errorMsg);
                skipped++;
            }
        }

        writePromptConfig(config);
        LOG.debug(String.format("[PromptManager] Batch import completed: %d imported, %d updated, %d skipped",
                imported, updated, skipped));

        result.put("imported", imported);
        result.put("updated", updated);
        result.put("skipped", skipped);
        result.put("errors", errors);
        result.put("success", errors.isEmpty());

        return result;
    }
}

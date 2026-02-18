package com.github.claudecodegui.settings;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * Skill Manager.
 * Manages Skills configuration.
 */
public class SkillManager {
    private static final Logger LOG = Logger.getInstance(SkillManager.class);

    private final Function<Void, JsonObject> configReader;
    private final java.util.function.Consumer<JsonObject> configWriter;
    private final ClaudeSettingsManager claudeSettingsManager;

    public SkillManager(
            Function<Void, JsonObject> configReader,
            java.util.function.Consumer<JsonObject> configWriter,
            ClaudeSettingsManager claudeSettingsManager) {
        this.configReader = configReader;
        this.configWriter = configWriter;
        this.claudeSettingsManager = claudeSettingsManager;
    }

    /**
     * Get all Skills configurations.
     */
    public List<JsonObject> getSkills() {
        List<JsonObject> result = new ArrayList<>();
        JsonObject config = configReader.apply(null);

        if (!config.has("skills")) {
            return result;
        }

        JsonObject skills = config.getAsJsonObject("skills");
        for (String key : skills.keySet()) {
            JsonObject skill = skills.getAsJsonObject(key);
            // Ensure ID exists
            if (!skill.has("id")) {
                skill.addProperty("id", key);
            }
            result.add(skill);
        }

        LOG.info("[SkillManager] Loaded " + result.size() + " skills");
        return result;
    }

    /**
     * Add or update a Skill.
     */
    public void upsertSkill(JsonObject skill) throws IOException {
        if (!skill.has("id")) {
            throw new IllegalArgumentException("Skill must have an id");
        }

        String id = skill.get("id").getAsString();

        // Validate Skill configuration
        Map<String, Object> validation = validateSkill(skill);
        if (!(boolean) validation.get("valid")) {
            @SuppressWarnings("unchecked")
            List<String> errors = (List<String>) validation.get("errors");
            throw new IllegalArgumentException("Invalid skill configuration: " + String.join(", ", errors));
        }

        JsonObject config = configReader.apply(null);

        // Ensure skills node exists
        if (!config.has("skills")) {
            config.add("skills", new JsonObject());
        }

        JsonObject skills = config.getAsJsonObject("skills");

        // Add or update the Skill
        skills.add(id, skill);

        // Write config
        configWriter.accept(config);

        // Sync to Claude settings
        syncSkillsToClaudeSettings();

        LOG.info("[SkillManager] Upserted skill: " + id);
    }

    /**
     * Delete a Skill.
     */
    public boolean deleteSkill(String id) throws IOException {
        JsonObject config = configReader.apply(null);

        if (!config.has("skills")) {
            LOG.info("[SkillManager] No skills found");
            return false;
        }

        JsonObject skills = config.getAsJsonObject("skills");
        if (!skills.has(id)) {
            LOG.info("[SkillManager] Skill not found: " + id);
            return false;
        }

        // Delete the Skill
        skills.remove(id);

        // Write config
        configWriter.accept(config);

        // Sync to Claude settings
        syncSkillsToClaudeSettings();

        LOG.info("[SkillManager] Deleted skill: " + id);
        return true;
    }

    /**
     * Validate Skill configuration.
     * Skills are folders containing a SKILL.md file; IDs must be in hyphen-case format.
     */
    public Map<String, Object> validateSkill(JsonObject skill) {
        List<String> errors = new ArrayList<>();

        // Validate ID (must be hyphen-case: lowercase letters, digits, and hyphens)
        if (!skill.has("id") || skill.get("id").isJsonNull() ||
                skill.get("id").getAsString().trim().isEmpty()) {
            errors.add("Skill ID must not be empty");
        } else {
            String id = skill.get("id").getAsString();
            // Skill ID format: only lowercase letters, digits, and hyphens allowed (hyphen-case)
            if (!id.matches("^[a-z0-9-]+$")) {
                errors.add("Skill ID may only contain lowercase letters, digits, and hyphens (hyphen-case)");
            }
        }

        // Validate name
        if (!skill.has("name") || skill.get("name").isJsonNull() ||
                skill.get("name").getAsString().trim().isEmpty()) {
            errors.add("Skill name must not be empty");
        }

        // Validate path (must be a folder path containing SKILL.md)
        if (!skill.has("path") || skill.get("path").isJsonNull() ||
                skill.get("path").getAsString().trim().isEmpty()) {
            errors.add("Skill path must not be empty");
        }

        // Validate type (currently only 'local' is supported)
        if (skill.has("type") && !skill.get("type").isJsonNull()) {
            String type = skill.get("type").getAsString();
            if (!"local".equals(type)) {
                errors.add("Unsupported Skill type: " + type + " (only 'local' is currently supported)");
            }
        }

        Map<String, Object> result = new java.util.HashMap<>();
        result.put("valid", errors.isEmpty());
        result.put("errors", errors);
        return result;
    }

    /**
     * Sync Skills to Claude settings.json.
     * Converts enabled Skills to the SDK plugins format.
     */
    public void syncSkillsToClaudeSettings() throws IOException {
        List<JsonObject> skills = getSkills();

        // Build the plugins array
        JsonArray plugins = new JsonArray();
        for (JsonObject skill : skills) {
            // Only sync enabled Skills
            boolean enabled = !skill.has("enabled") || skill.get("enabled").isJsonNull() ||
                    skill.get("enabled").getAsBoolean();
            if (!enabled) {
                continue;
            }

            // Convert to SDK SdkPluginConfig format
            JsonObject plugin = new JsonObject();
            plugin.addProperty("type", "local");
            plugin.addProperty("path", skill.get("path").getAsString());
            plugins.add(plugin);
        }

        // Delegate to ClaudeSettingsManager for the sync
        claudeSettingsManager.syncSkillsToClaudeSettings(plugins);

        LOG.info("[SkillManager] Synced " + plugins.size() + " enabled skills to Claude settings");
    }
}

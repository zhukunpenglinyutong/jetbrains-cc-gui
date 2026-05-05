package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.project.Project;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Project Prompt Manager.
 * Manages prompts stored in the project directory (<project>/codemoss/prompt.json).
 * These prompts are specific to the current project.
 */
public class ProjectPromptManager extends AbstractPromptManager {
    private static final String PROJECT_PROMPT_DIR_NAME = "codemoss";
    private static final String LEGACY_PROJECT_PROMPT_DIR_NAME = ".codemoss";
    private static final String PROMPT_FILE_NAME = "prompt.json";

    private final Project project;

    /**
     * Constructor for ProjectPromptManager.
     * @param gson Gson instance for JSON serialization/deserialization
     * @param project IntelliJ Project instance for accessing project base path
     */
    public ProjectPromptManager(Gson gson, Project project) {
        super(gson);
        this.project = project;
    }

    /**
     * Get the storage path for project-specific prompts.
     * @return Path to <project>/codemoss/prompt.json
     * @throws IllegalStateException if project is not available or has no base path
     */
    @Override
    protected Path getStoragePath() throws IOException {
        return getPreferredStoragePath();
    }

    @Override
    public JsonObject readPromptConfig() throws IOException {
        Path preferredPath = getPreferredStoragePath();
        if (Files.exists(preferredPath)) {
            return super.readPromptConfig();
        }

        Path legacyPath = getLegacyStoragePath();
        if (!Files.exists(legacyPath)) {
            return super.readPromptConfig();
        }

        try (BufferedReader reader = Files.newBufferedReader(legacyPath, StandardCharsets.UTF_8)) {
            JsonObject config = JsonParser.parseReader(reader).getAsJsonObject();
            if (!config.has("prompts")) {
                config.add("prompts", new JsonObject());
            }
            return config;
        } catch (Exception e) {
            JsonObject config = new JsonObject();
            config.add("prompts", new JsonObject());
            return config;
        }
    }

    /**
     * Ensure the storage directory exists.
     * Creates <project>/codemoss directory if it doesn't exist.
     * @throws IOException if directory creation fails
     */
    @Override
    protected void ensureStorageDirectory() throws IOException {
        Path filePath = getPreferredStoragePath();
        Path dir = filePath.getParent();

        com.intellij.openapi.diagnostic.Logger LOG =
            com.intellij.openapi.diagnostic.Logger.getInstance(ProjectPromptManager.class);

        LOG.warn("[ProjectPromptManager] Ensuring directory exists: " + dir);
        LOG.warn("[ProjectPromptManager] Target file path: " + filePath);

        if (!Files.exists(dir)) {
            Files.createDirectories(dir);
            LOG.warn("[ProjectPromptManager] ✓ Created directory: " + dir);
        } else {
            LOG.warn("[ProjectPromptManager] Directory already exists: " + dir);
        }
    }

    private Path getPreferredStoragePath() {
        if (project == null || project.getBasePath() == null) {
            throw new IllegalStateException("Project not available");
        }
        return Paths.get(project.getBasePath(), PROJECT_PROMPT_DIR_NAME, PROMPT_FILE_NAME);
    }

    private Path getLegacyStoragePath() {
        if (project == null || project.getBasePath() == null) {
            throw new IllegalStateException("Project not available");
        }
        return Paths.get(project.getBasePath(), LEGACY_PROJECT_PROMPT_DIR_NAME, PROMPT_FILE_NAME);
    }
}

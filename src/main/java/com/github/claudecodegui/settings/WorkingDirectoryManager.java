package com.github.claudecodegui.settings;

import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;

/**
 * Working Directory Manager.
 * Manages custom working directory configuration for projects.
 */
public class WorkingDirectoryManager {
    private static final Logger LOG = Logger.getInstance(WorkingDirectoryManager.class);

    private final Function<Void, JsonObject> configReader;
    private final java.util.function.Consumer<JsonObject> configWriter;

    public WorkingDirectoryManager(
            Function<Void, JsonObject> configReader,
            java.util.function.Consumer<JsonObject> configWriter) {
        this.configReader = configReader;
        this.configWriter = configWriter;
    }

    /**
     * Get the custom working directory configuration.
     * @param projectPath the project root path
     * @return the custom working directory, or null if not configured
     */
    public String getCustomWorkingDirectory(String projectPath) {
        JsonObject config = configReader.apply(null);

        if (!config.has("workingDirectories") || config.get("workingDirectories").isJsonNull()) {
            return null;
        }

        JsonObject workingDirs = config.getAsJsonObject("workingDirectories");

        if (workingDirs.has(projectPath) && !workingDirs.get(projectPath).isJsonNull()) {
            return workingDirs.get(projectPath).getAsString();
        }

        return null;
    }

    /**
     * Set the custom working directory.
     * @param projectPath the project root path
     * @param customWorkingDir the custom working directory (relative to project root or absolute path)
     */
    public void setCustomWorkingDirectory(String projectPath, String customWorkingDir) throws IOException {
        JsonObject config = configReader.apply(null);

        // Ensure the workingDirectories node exists
        if (!config.has("workingDirectories")) {
            config.add("workingDirectories", new JsonObject());
        }

        JsonObject workingDirs = config.getAsJsonObject("workingDirectories");

        if (customWorkingDir == null || customWorkingDir.trim().isEmpty()) {
            // If an empty value is provided, remove the configuration
            workingDirs.remove(projectPath);
        } else {
            // Set the custom working directory
            workingDirs.addProperty(projectPath, customWorkingDir.trim());
        }

        configWriter.accept(config);
        LOG.info("[WorkingDirectoryManager] Set custom working directory for " + projectPath + ": " + customWorkingDir);
    }

    /**
     * Get all working directory configurations.
     * @return Map<projectPath, customWorkingDir>
     */
    public Map<String, String> getAllWorkingDirectories() {
        Map<String, String> result = new HashMap<>();
        JsonObject config = configReader.apply(null);

        if (!config.has("workingDirectories") || config.get("workingDirectories").isJsonNull()) {
            return result;
        }

        JsonObject workingDirs = config.getAsJsonObject("workingDirectories");
        for (String key : workingDirs.keySet()) {
            result.put(key, workingDirs.get(key).getAsString());
        }

        return result;
    }
}

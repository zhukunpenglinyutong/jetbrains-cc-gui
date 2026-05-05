package com.github.claudecodegui.watcher;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.model.PromptScope;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.openapi.vfs.newvfs.BulkFileListener;
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent;
import com.intellij.openapi.vfs.newvfs.events.VFileEvent;
import com.intellij.util.messages.MessageBusConnection;
import org.jetbrains.annotations.NotNull;

import java.util.List;
import java.util.function.BiConsumer;

/**
 * Watches for changes to prompt.json files and notifies listeners.
 * Monitors both global and project-specific prompt files for external modifications.
 */
public class PromptFileWatcher implements BulkFileListener {
    private static final Logger LOG = Logger.getInstance(PromptFileWatcher.class);

    private final Project project;
    private final CodemossSettingsService settingsService;
    private final Gson gson;
    private final BiConsumer<PromptScope, String> onPromptsChanged;
    private MessageBusConnection connection;

    /**
     * Create a new PromptFileWatcher.
     *
     * @param project IntelliJ Project instance
     * @param settingsService Settings service for loading prompts
     * @param onPromptsChanged Callback when prompts change: (scope, promptsJson) -> void
     */
    public PromptFileWatcher(
        Project project,
        CodemossSettingsService settingsService,
        BiConsumer<PromptScope, String> onPromptsChanged
    ) {
        this.project = project;
        this.settingsService = settingsService;
        this.gson = new Gson();
        this.onPromptsChanged = onPromptsChanged;
    }

    @Override
    public void after(@NotNull List<? extends VFileEvent> events) {
        for (VFileEvent event : events) {
            // Only handle content change events (file modifications)
            if (!(event instanceof VFileContentChangeEvent)) {
                continue;
            }

            VirtualFile file = event.getFile();
            if (file == null) {
                continue;
            }

            String filePath = file.getPath();

            // Check if this is a project prompt.json file
            if (isProjectPromptFile(filePath)) {
                LOG.info("[PromptFileWatcher] Detected change in project prompt.json: " + filePath);
                reloadAndNotify(PromptScope.PROJECT);
                continue;
            }

            // Check if this is a global prompt.json file
            if (isGlobalPromptFile(filePath)) {
                LOG.info("[PromptFileWatcher] Detected change in global prompt.json: " + filePath);
                reloadAndNotify(PromptScope.GLOBAL);
            }
        }
    }

    /**
     * Check if the file path matches project prompt.json pattern.
     * Patterns: <project-path>/codemoss/prompt.json, <project-path>/.codemoss/prompt.json
     */
    private boolean isProjectPromptFile(String filePath) {
        if (project == null || project.getBasePath() == null) {
            return false;
        }

        String basePath = normalizePath(project.getBasePath());
        String normalizedFilePath = normalizePath(filePath);
        String projectPromptPath = basePath + "/codemoss/prompt.json";
        String legacyProjectPromptPath = basePath + "/.codemoss/prompt.json";
        return normalizedFilePath.equals(projectPromptPath) || normalizedFilePath.equals(legacyProjectPromptPath);
    }

    /**
     * Check if the file path matches global prompt.json pattern.
     * Pattern: ~/.codemoss/prompt.json
     */
    private boolean isGlobalPromptFile(String filePath) {
        String homeDir = PlatformUtils.getHomeDirectory();
        String globalPromptPath = normalizePath(homeDir) + "/.codemoss/prompt.json";
        return normalizePath(filePath).equals(globalPromptPath);
    }

    private String normalizePath(String path) {
        return path == null ? "" : path.replace('\\', '/');
    }

    /**
     * Reload prompts from file and notify listeners.
     */
    private void reloadAndNotify(PromptScope scope) {
        try {
            // Reload prompts from file
            List<JsonObject> prompts = settingsService.getPrompts(scope, project);
            String promptsJson = gson.toJson(prompts);

            // Notify listeners (will update frontend cache)
            if (onPromptsChanged != null) {
                onPromptsChanged.accept(scope, promptsJson);
            }

            LOG.info("[PromptFileWatcher] Reloaded " + prompts.size() + " prompts for scope=" + scope.getValue());
        } catch (Exception e) {
            LOG.error("[PromptFileWatcher] Failed to reload prompts for scope=" + scope.getValue(), e);
        }
    }

    /**
     * Start watching for file changes.
     * Uses MessageBusConnection for automatic cleanup when project is disposed.
     */
    public void startWatching() {
        if (connection != null) {
            LOG.warn("[PromptFileWatcher] Already watching, skipping");
            return;
        }

        // Create connection tied to project lifecycle (auto-disposed on project close)
        connection = project.getMessageBus().connect();
        connection.subscribe(VirtualFileManager.VFS_CHANGES, this);

        LOG.info("[PromptFileWatcher] Started watching prompt files");
    }

    /**
     * Stop watching for file changes.
     * Call this method when you want to manually stop watching.
     * Note: Connection will be auto-disposed when project closes.
     */
    public void stopWatching() {
        if (connection != null) {
            connection.disconnect();
            connection = null;
            LOG.info("[PromptFileWatcher] Stopped watching prompt files");
        }
    }
}

package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.context.ContextCollector;
import com.github.claudecodegui.util.EditorFileUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.project.Project;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Editor context collector.
 * Collects context information from the IDE editor (open files, selected code, etc.).
 */
public class EditorContextCollector {
    private static final Logger LOG = Logger.getInstance(EditorContextCollector.class);

    private final Project project;
    private boolean psiContextEnabled = true;
    private boolean autoOpenFileEnabled = true;

    private boolean isQuickFix = false;

    public EditorContextCollector(Project project) {
        this.project = project;
    }

    public void setQuickFix(boolean quickFix) {
        this.isQuickFix = quickFix;
    }

    public void setPsiContextEnabled(boolean enabled) {
        this.psiContextEnabled = enabled;
    }

    /**
     * Set whether auto open file (editor context collection) is enabled.
     * When disabled, collectContext() returns an empty object and AI receives no editor context.
     */
    public void setAutoOpenFileEnabled(boolean enabled) {
        this.autoOpenFileEnabled = enabled;
    }

    /**
     * Asynchronously collect editor context information.
     * Returns an empty object if autoOpenFileEnabled is false.
     */
    public CompletableFuture<JsonObject> collectContext() {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();

        // If the user has disabled the auto open file toggle, skip all editor context collection
        if (!autoOpenFileEnabled) {
            LOG.info("Auto open file disabled, skipping editor context collection");
            future.complete(new JsonObject());
            return future;
        }

        // First, get editor on EDT (required for getSelectedTextEditor)
        AtomicReference<Editor> editorRef = new AtomicReference<>();
        AtomicReference<String> activeFileRef = new AtomicReference<>();

        ApplicationManager.getApplication().invokeAndWait(() -> {
            try {
                editorRef.set(FileEditorManager.getInstance(project).getSelectedTextEditor());
                activeFileRef.set(EditorFileUtils.getCurrentActiveFile(project));
            } catch (Exception e) {
                LOG.warn("Failed to get editor on EDT: " + e.getMessage());
            }
        });

        // Then collect context in background read action
        ReadAction
            .nonBlocking(() -> {
                try {
                    return buildContextJson(editorRef.get(), activeFileRef.get());
                } catch (Exception e) {
                    LOG.warn("Failed to get file info: " + e.getMessage());
                    return new JsonObject();
                }
            })
            .finishOnUiThread(com.intellij.openapi.application.ModalityState.defaultModalityState(), future::complete)
            .submit(AppExecutorUtil.getAppExecutorService());

        return future;
    }

    /**
     * Build the context JSON object.
     */
    private JsonObject buildContextJson(Editor editor, String activeFile) {
        /*
         * ========== Editor Context Information Collection ==========
         *
         * Collects the user's working environment in the IDEA editor to help AI
         * understand the current code context. This information is built into JSON
         * format and appended to the system prompt sent to AI.
         *
         * Collected information is organized in four priority layers:
         * 1. active (currently active file) - Highest priority, AI's primary focus
         * 2. selection (user-selected code) - If present, the core target for AI analysis
         * 3. semantic (PSI semantic info) - Code structure, references, inheritance, etc.
         * 4. others (other open files) - Lowest priority, potential context references
         */

        List<String> allOpenedFiles = EditorFileUtils.getOpenedFiles(project);
        Map<String, Object> selectionInfo = EditorFileUtils.getSelectedCodeInfo(project);

        JsonObject openedFilesJson = new JsonObject();

        if (activeFile != null) {
            // Add the currently active file path
            openedFilesJson.addProperty("active", activeFile);
            LOG.debug("Current active file: " + activeFile);

            // If the user has selected code, add selection info
            if (selectionInfo != null) {
                JsonObject selectionJson = new JsonObject();
                selectionJson.addProperty("startLine", (Integer) selectionInfo.get("startLine"));
                selectionJson.addProperty("endLine", (Integer) selectionInfo.get("endLine"));
                selectionJson.addProperty("selectedText", (String) selectionInfo.get("selectedText"));
                openedFilesJson.add("selection", selectionJson);
                LOG.debug("Code selection detected: lines " +
                    selectionInfo.get("startLine") + "-" + selectionInfo.get("endLine"));
            }

            // Collect PSI semantic context (all files)
            if (psiContextEnabled && editor != null && activeFile != null) {
                try {
                    ContextCollector semanticCollector = new ContextCollector();
                    JsonObject semanticContext = semanticCollector.collectSemanticContext(editor, project);
                    if (semanticContext != null && semanticContext.size() > 0) {
                        // Merge semantic context properties directly into main object
                        for (String key : semanticContext.keySet()) {
                            openedFilesJson.add(key, semanticContext.get(key));
                        }
                        LOG.debug("PSI semantic context merged for: " + activeFile);
                    }
                } catch (Exception e) {
                    LOG.warn("Failed to collect PSI semantic context: " + e.getMessage());
                }
            }
        }

        // Add other open files (excluding the active file to avoid duplication)
        JsonArray othersArray = new JsonArray();
        for (String file : allOpenedFiles) {
            if (!file.equals(activeFile)) {
                othersArray.add(file);
            }
        }
        if (othersArray.size() > 0) {
            openedFilesJson.add("others", othersArray);
            LOG.debug("Other opened files count: " + othersArray.size());
        }

        if (isQuickFix) {
            openedFilesJson.addProperty("isQuickFix", true);
        }

        return openedFilesJson;
    }
}

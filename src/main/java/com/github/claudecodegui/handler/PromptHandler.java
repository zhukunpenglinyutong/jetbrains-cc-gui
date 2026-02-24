package com.github.claudecodegui.handler;

import com.github.claudecodegui.CodemossSettingsService;
import com.github.claudecodegui.model.ConflictStrategy;
import com.github.claudecodegui.settings.PromptManager;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.notification.Notification;
import com.intellij.notification.NotificationType;
import com.intellij.notification.Notifications;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.LocalFileSystem;

import java.awt.*;
import java.io.File;
import java.io.FileWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.List;

/**
 * Prompt library management message handler.
 */
public class PromptHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(PromptHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "get_prompts",
        "add_prompt",
        "update_prompt",
        "delete_prompt",
        "export_prompts",
        "import_prompts_file",
        "save_imported_prompts"
    };

    private final CodemossSettingsService settingsService;
    private final Gson gson;

    public PromptHandler(HandlerContext context) {
        super(context);
        this.settingsService = context.getSettingsService();
        this.gson = new Gson();
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_prompts":
                handleGetPrompts();
                return true;
            case "add_prompt":
                handleAddPrompt(content);
                return true;
            case "update_prompt":
                handleUpdatePrompt(content);
                return true;
            case "delete_prompt":
                handleDeletePrompt(content);
                return true;
            case "export_prompts":
                handleExportPrompts(content);
                return true;
            case "import_prompts_file":
                handleImportPromptsFile();
                return true;
            case "save_imported_prompts":
                handleSaveImportedPrompts(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Get all prompts.
     */
    private void handleGetPrompts() {
        try {
            List<JsonObject> prompts = settingsService.getPrompts();
            String promptsJson = gson.toJson(prompts);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updatePrompts", escapeJs(promptsJson));
            });
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to get prompts: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updatePrompts", escapeJs("[]"));
            });
        }
    }

    /**
     * Add a prompt.
     */
    private void handleAddPrompt(String content) {
        try {
            JsonObject prompt = gson.fromJson(content, JsonObject.class);
            settingsService.addPrompt(prompt);

            // Refresh the list
            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetPrompts();
                callJavaScript("window.promptOperationResult", escapeJs("{\"success\":true,\"operation\":\"add\"}"));
            });
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to add prompt: " + e.getMessage(), e);
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("operation", "add");
            errorResult.addProperty("error", e.getMessage());
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.promptOperationResult", escapeJs(gson.toJson(errorResult)));
            });
        }
    }

    /**
     * Update a prompt.
     */
    private void handleUpdatePrompt(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);

            if (!data.has("id") || data.get("id").isJsonNull()) {
                LOG.error("[PromptHandler] Missing 'id' field in update request");
                sendErrorResult("update", "Missing 'id' field in request");
                return;
            }
            if (!data.has("updates") || data.get("updates").isJsonNull()) {
                LOG.error("[PromptHandler] Missing 'updates' field in update request");
                sendErrorResult("update", "Missing 'updates' field in request");
                return;
            }

            String id = data.get("id").getAsString();
            JsonObject updates = data.getAsJsonObject("updates");

            settingsService.updatePrompt(id, updates);

            // Refresh the list
            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetPrompts();
                callJavaScript("window.promptOperationResult", escapeJs("{\"success\":true,\"operation\":\"update\"}"));
            });
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to update prompt: " + e.getMessage(), e);
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("operation", "update");
            errorResult.addProperty("error", e.getMessage());
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.promptOperationResult", escapeJs(gson.toJson(errorResult)));
            });
        }
    }

    /**
     * Delete a prompt.
     */
    private void handleDeletePrompt(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);

            if (!data.has("id") || data.get("id").isJsonNull()) {
                LOG.error("[PromptHandler] Missing 'id' field in delete request");
                sendErrorResult("delete", "Missing 'id' field in request");
                return;
            }

            String id = data.get("id").getAsString();

            boolean deleted = settingsService.deletePrompt(id);

            if (deleted) {
                // Refresh the list
                ApplicationManager.getApplication().invokeLater(() -> {
                    handleGetPrompts();
                    callJavaScript("window.promptOperationResult", escapeJs("{\"success\":true,\"operation\":\"delete\"}"));
                });
            } else {
                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("success", false);
                errorResult.addProperty("operation", "delete");
                errorResult.addProperty("error", "Prompt not found");
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.promptOperationResult", escapeJs(gson.toJson(errorResult)));
                });
            }
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to delete prompt: " + e.getMessage(), e);
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("operation", "delete");
            errorResult.addProperty("error", e.getMessage());
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.promptOperationResult", escapeJs(gson.toJson(errorResult)));
            });
        }
    }

    /**
     * Send error result to frontend
     */
    private void sendErrorResult(String operation, String error) {
        JsonObject errorResult = new JsonObject();
        errorResult.addProperty("success", false);
        errorResult.addProperty("operation", operation);
        errorResult.addProperty("error", error);
        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.promptOperationResult", escapeJs(gson.toJson(errorResult)));
        });
    }

    /**
     * Handle exporting selected prompts to a JSON file.
     */
    private void handleExportPrompts(String content) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                List<JsonObject> prompts = settingsService.getPrompts();

                // Filter prompts by selected IDs if provided
                if (content != null && !content.isEmpty()) {
                    try {
                        JsonObject data = gson.fromJson(content, JsonObject.class);
                        if (data.has("promptIds")) {
                            JsonArray promptIdsArray = data.getAsJsonArray("promptIds");
                            java.util.Set<String> selectedIds = new java.util.HashSet<>();
                            for (int i = 0; i < promptIdsArray.size(); i++) {
                                selectedIds.add(promptIdsArray.get(i).getAsString());
                            }

                            prompts = prompts.stream()
                                .filter(prompt -> {
                                    String id = prompt.has("id") ? prompt.get("id").getAsString() : "";
                                    return selectedIds.contains(id);
                                })
                                .collect(java.util.stream.Collectors.toList());
                        }
                    } catch (Exception e) {
                        LOG.warn("[PromptHandler] Failed to parse promptIds, exporting all: " + e.getMessage());
                    }
                }

                if (prompts.isEmpty()) {
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Export Failed",
                            "No prompts to export",
                            NotificationType.WARNING
                    ));
                    return;
                }

                // Create export data structure
                SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
                String exportTime = dateFormat.format(new Date());

                JsonObject exportData = new JsonObject();
                exportData.addProperty("format", "claude-code-prompts-export-v1");
                exportData.addProperty("exportTime", exportTime);
                exportData.addProperty("promptCount", prompts.size());

                JsonArray promptsArray = new JsonArray();
                for (JsonObject prompt : prompts) {
                    promptsArray.add(prompt);
                }
                exportData.add("prompts", promptsArray);

                // Open file save dialog
                FileDialog fileDialog = new FileDialog((Frame) null, "Export Prompts", FileDialog.SAVE);

                // Generate default filename with timestamp
                SimpleDateFormat filenameDateFormat = new SimpleDateFormat("yyyyMMdd-HHmmss");
                String defaultFilename = "prompts-" + filenameDateFormat.format(new Date()) + ".json";
                fileDialog.setFile(defaultFilename);
                fileDialog.setFilenameFilter((dir, name) -> name.toLowerCase().endsWith(".json"));
                fileDialog.setVisible(true);

                String directory = fileDialog.getDirectory();
                String filename = fileDialog.getFile();

                if (directory == null || filename == null) {
                    LOG.info("[PromptHandler] Export cancelled by user");
                    return;
                }

                File file = new File(directory, filename);

                // Write JSON to file
                try (FileWriter writer = new FileWriter(file, StandardCharsets.UTF_8)) {
                    gson.toJson(exportData, writer);
                    LOG.info("[PromptHandler] Successfully exported " + prompts.size() + " prompts to " + file.getAbsolutePath());

                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Export Successful",
                            "Exported " + prompts.size() + " prompts to " + filename,
                            NotificationType.INFORMATION
                    ));
                } catch (Exception e) {
                    LOG.error("[PromptHandler] Failed to write export file: " + e.getMessage(), e);
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Export Failed",
                            "Failed to write file: " + e.getMessage(),
                            NotificationType.ERROR
                    ));
                }
            } catch (Exception e) {
                LOG.error("[PromptHandler] Failed to export prompts: " + e.getMessage(), e);
                Notifications.Bus.notify(new Notification(
                        "Codemoss",
                        "Export Failed",
                        "Failed to export prompts: " + e.getMessage(),
                        NotificationType.ERROR
                ));
            }
        });
    }

    /**
     * Handle importing prompts from a JSON file.
     */
    private void handleImportPromptsFile() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                // Create file chooser descriptor for JSON files
                FileChooserDescriptor descriptor = new FileChooserDescriptor(
                    true,  // chooseFiles
                    false, // chooseFolders
                    false, // chooseJars
                    false, // chooseJarsAsFiles
                    false, // chooseJarContents
                    false  // chooseMultiple
                );
                descriptor.setTitle("Import Prompts");
                descriptor.setDescription("Select a JSON file containing exported prompts");
                descriptor.withFileFilter(vFile -> vFile.getExtension() != null && vFile.getExtension().equalsIgnoreCase("json"));

                // Set initial directory to project base path
                VirtualFile initialDir = null;
                String projectPath = context.getProject().getBasePath();
                if (projectPath != null) {
                    initialDir = LocalFileSystem.getInstance().findFileByPath(projectPath);
                }

                // Show file chooser
                VirtualFile[] selectedFiles = FileChooser.chooseFiles(descriptor, context.getProject(), initialDir);

                if (selectedFiles.length == 0) {
                    LOG.info("[PromptHandler] Import cancelled by user");
                    return;
                }

                VirtualFile selectedFile = selectedFiles[0];
                File file = new File(selectedFile.getPath());

                // Check file size (limit to 5MB)
                long fileSize = file.length();
                long maxSize = 5 * 1024 * 1024; // 5MB
                if (fileSize > maxSize) {
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Import Failed",
                            "File size exceeds 5MB limit",
                            NotificationType.ERROR
                    ));
                    return;
                }

                // Read and parse file
                String fileContent = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
                JsonObject importData = JsonParser.parseString(fileContent).getAsJsonObject();

                // Validate format
                if (!importData.has("format") || !importData.get("format").getAsString().startsWith("claude-code-prompts-export-v")) {
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Import Failed",
                            "Invalid file format. Please select a valid prompts export file.",
                            NotificationType.ERROR
                    ));
                    return;
                }

                if (!importData.has("prompts")) {
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Import Failed",
                            "No prompts found in file",
                            NotificationType.ERROR
                    ));
                    return;
                }

                JsonArray promptsArray = importData.getAsJsonArray("prompts");
                List<JsonObject> promptsToImport = new ArrayList<>();

                for (int i = 0; i < promptsArray.size(); i++) {
                    promptsToImport.add(promptsArray.get(i).getAsJsonObject());
                }

                // Validate and detect conflicts
                PromptManager promptManager = settingsService.getPromptManager();
                Set<String> conflicts = promptManager.detectConflicts(promptsToImport);

                // Prepare preview data
                JsonObject previewData = new JsonObject();
                JsonArray itemsArray = new JsonArray();

                for (JsonObject prompt : promptsToImport) {
                    String validationError = promptManager.validatePrompt(prompt);
                    if (validationError != null) {
                        LOG.warn("[PromptHandler] Invalid prompt in import: " + validationError);
                        continue;
                    }

                    String id = prompt.get("id").getAsString();
                    boolean hasConflict = conflicts.contains(id);

                    JsonObject item = new JsonObject();
                    item.add("data", prompt);
                    item.addProperty("status", hasConflict ? "update" : "new");
                    item.addProperty("conflict", hasConflict);
                    itemsArray.add(item);
                }

                previewData.add("items", itemsArray);

                JsonObject summary = new JsonObject();
                summary.addProperty("total", itemsArray.size());
                summary.addProperty("newCount", (int) itemsArray.asList().stream()
                        .filter(item -> !item.getAsJsonObject().get("conflict").getAsBoolean()).count());
                summary.addProperty("updateCount", conflicts.size());
                previewData.add("summary", summary);

                // Send preview to frontend
                String previewJson = gson.toJson(previewData);
                callJavaScript("window.promptImportPreviewResult", escapeJs(previewJson));

                LOG.info("[PromptHandler] Prepared import preview with " + itemsArray.size() + " prompts");

            } catch (Exception e) {
                LOG.error("[PromptHandler] Failed to import prompts file: " + e.getMessage(), e);
                Notifications.Bus.notify(new Notification(
                        "Codemoss",
                        "Import Failed",
                        "Failed to read file: " + e.getMessage(),
                        NotificationType.ERROR
                ));
            }
        });
    }

    /**
     * Handle saving imported prompts.
     */
    private void handleSaveImportedPrompts(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);

            if (!data.has("prompts") || !data.has("strategy")) {
                LOG.error("[PromptHandler] Missing required fields in save request");
                sendImportErrorResult("Missing required fields");
                return;
            }

            JsonArray selectedPromptsArray = data.getAsJsonArray("prompts");
            String strategyStr = data.get("strategy").getAsString();
            ConflictStrategy strategy = ConflictStrategy.fromValue(strategyStr);

            List<JsonObject> promptsToImport = new ArrayList<>();
            for (int i = 0; i < selectedPromptsArray.size(); i++) {
                promptsToImport.add(selectedPromptsArray.get(i).getAsJsonObject());
            }

            PromptManager promptManager = settingsService.getPromptManager();
            Map<String, Object> result = promptManager.batchImportPrompts(promptsToImport, strategy);

            // Send result to frontend
            ApplicationManager.getApplication().invokeLater(() -> {
                String resultJson = gson.toJson(result);
                callJavaScript("window.promptImportResult", escapeJs(resultJson));

                // Refresh the list
                handleGetPrompts();

                // Show notification
                boolean success = (boolean) result.get("success");
                int imported = (int) result.get("imported");
                int updated = (int) result.get("updated");
                int skipped = (int) result.get("skipped");

                if (success) {
                    String message = String.format("Imported %d prompts (%d new, %d updated, %d skipped)",
                            imported + updated, imported, updated, skipped);
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Import Successful",
                            message,
                            NotificationType.INFORMATION
                    ));
                } else {
                    @SuppressWarnings("unchecked")
                    List<String> errors = (List<String>) result.get("errors");
                    String errorMsg = errors.isEmpty() ? "Unknown error" : errors.get(0);
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Import Failed",
                            errorMsg,
                            NotificationType.ERROR
                    ));
                }

                LOG.info(String.format("[PromptHandler] Import completed: %d imported, %d updated, %d skipped",
                        imported, updated, skipped));
            });

        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to save imported prompts: " + e.getMessage(), e);
            sendImportErrorResult("Failed to save prompts: " + e.getMessage());
        }
    }

    /**
     * Send import error result to frontend
     */
    private void sendImportErrorResult(String error) {
        JsonObject errorResult = new JsonObject();
        errorResult.addProperty("success", false);
        errorResult.addProperty("error", error);
        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.promptImportResult", escapeJs(gson.toJson(errorResult)));
            Notifications.Bus.notify(new Notification(
                    "Codemoss",
                    "Import Failed",
                    error,
                    NotificationType.ERROR
            ));
        });
    }
}

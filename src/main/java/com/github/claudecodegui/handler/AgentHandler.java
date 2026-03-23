package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.model.ConflictStrategy;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
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
import java.util.Date;
import java.util.List;
import java.util.Map;

/**
 * Agent management message handler.
 */
public class AgentHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(AgentHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "get_agents",
        "add_agent",
        "update_agent",
        "delete_agent",
        "get_selected_agent",
        "set_selected_agent",
        "export_agents",
        "import_agents_file",
        "save_imported_agents"
    };

    private final CodemossSettingsService settingsService;
    private final Gson gson;

    public AgentHandler(HandlerContext context) {
        super(context);
        this.settingsService = new CodemossSettingsService();
        this.gson = new Gson();
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_agents":
                handleGetAgents();
                return true;
            case "add_agent":
                handleAddAgent(content);
                return true;
            case "update_agent":
                handleUpdateAgent(content);
                return true;
            case "delete_agent":
                handleDeleteAgent(content);
                return true;
            case "get_selected_agent":
                handleGetSelectedAgent();
                return true;
            case "set_selected_agent":
                handleSetSelectedAgent(content);
                return true;
            case "export_agents":
                handleExportAgents(content);
                return true;
            case "import_agents_file":
                handleImportAgentsFile();
                return true;
            case "save_imported_agents":
                handleSaveImportedAgents(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Get all agents.
     */
    private void handleGetAgents() {
        try {
            List<JsonObject> agents = settingsService.getAgents();
            String agentsJson = gson.toJson(agents);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateAgents", escapeJs(agentsJson));
            });
        } catch (Exception e) {
            LOG.error("[AgentHandler] Failed to get agents: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateAgents", escapeJs("[]"));
            });
        }
    }

    /**
     * Add an agent.
     */
    private void handleAddAgent(String content) {
        try {
            JsonObject agent = gson.fromJson(content, JsonObject.class);
            settingsService.addAgent(agent);

            // Refresh the list
            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetAgents();
                callJavaScript("window.agentOperationResult", escapeJs("{\"success\":true,\"operation\":\"add\"}"));
            });
        } catch (Exception e) {
            LOG.error("[AgentHandler] Failed to add agent: " + e.getMessage(), e);
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("operation", "add");
            errorResult.addProperty("error", e.getMessage());
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.agentOperationResult", escapeJs(gson.toJson(errorResult)));
            });
        }
    }

    /**
     * Update an agent.
     */
    private void handleUpdateAgent(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();
            JsonObject updates = data.getAsJsonObject("updates");

            settingsService.updateAgent(id, updates);

            // Refresh the list
            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetAgents();
                callJavaScript("window.agentOperationResult", escapeJs("{\"success\":true,\"operation\":\"update\"}"));
            });
        } catch (Exception e) {
            LOG.error("[AgentHandler] Failed to update agent: " + e.getMessage(), e);
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("operation", "update");
            errorResult.addProperty("error", e.getMessage());
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.agentOperationResult", escapeJs(gson.toJson(errorResult)));
            });
        }
    }

    /**
     * Delete an agent.
     */
    private void handleDeleteAgent(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();

            boolean deleted = settingsService.deleteAgent(id);

            if (deleted) {
                // If the deleted agent was the currently selected one, clear the selection
                try {
                    String selectedId = settingsService.getSelectedAgentId();
                    if (id.equals(selectedId)) {
                        settingsService.setSelectedAgentId(null);
                        // Notify frontend to clear the selection
                        callJavaScript("window.onSelectedAgentChanged", escapeJs("null"));
                    }
                } catch (Exception e) {
                    LOG.warn("[AgentHandler] Failed to check/clear selected agent: " + e.getMessage());
                }

                // Refresh the list
                ApplicationManager.getApplication().invokeLater(() -> {
                    handleGetAgents();
                    callJavaScript("window.agentOperationResult", escapeJs("{\"success\":true,\"operation\":\"delete\"}"));
                });
            } else {
                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("success", false);
                errorResult.addProperty("operation", "delete");
                errorResult.addProperty("error", "Agent not found");
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.agentOperationResult", escapeJs(gson.toJson(errorResult)));
                });
            }
        } catch (Exception e) {
            LOG.error("[AgentHandler] Failed to delete agent: " + e.getMessage(), e);
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("operation", "delete");
            errorResult.addProperty("error", e.getMessage());
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.agentOperationResult", escapeJs(gson.toJson(errorResult)));
            });
        }
    }

    /**
     * Get the currently selected agent.
     */
    private void handleGetSelectedAgent() {
        try {
            String selectedId = settingsService.getSelectedAgentId();
            JsonObject result = new JsonObject();

            if (selectedId != null && !selectedId.isEmpty()) {
                JsonObject agent = settingsService.getAgent(selectedId);
                if (agent != null) {
                    result.addProperty("selectedAgentId", selectedId);
                    result.add("agent", agent);
                } else {
                    // Agent was deleted, clear the selection
                    settingsService.setSelectedAgentId(null);
                    result.addProperty("selectedAgentId", (String) null);
                }
            } else {
                result.addProperty("selectedAgentId", (String) null);
            }

            String resultJson = gson.toJson(result);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.onSelectedAgentReceived", escapeJs(resultJson));
            });
        } catch (Exception e) {
            LOG.error("[AgentHandler] Failed to get selected agent: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.onSelectedAgentReceived", escapeJs("{\"selectedAgentId\":null}"));
            });
        }
    }

    /**
     * Set the selected agent.
     */
    private void handleSetSelectedAgent(String content) {
        try {
            String agentId = null;

            // Handle empty content (deselect agent)
            if (content != null && !content.isEmpty() && !content.equals("null")) {
                JsonObject data = gson.fromJson(content, JsonObject.class);
                if (data != null) {
                    // Support both field names: frontend sends "id", but "agentId" is also accepted
                    if (data.has("id") && !data.get("id").isJsonNull()) {
                        agentId = data.get("id").getAsString();
                    } else if (data.has("agentId") && !data.get("agentId").isJsonNull()) {
                        agentId = data.get("agentId").getAsString();
                    }
                }
            }

            LOG.info("[AgentHandler] Setting selected agent: " + (agentId != null ? agentId : "null"));
            settingsService.setSelectedAgentId(agentId);

            JsonObject result = new JsonObject();
            result.addProperty("success", true);

            if (agentId != null) {
                JsonObject agent = settingsService.getAgent(agentId);
                if (agent != null) {
                    result.add("agent", agent);
                    String agentName = agent.has("name") ? agent.get("name").getAsString() : "Unknown Agent";
                    com.github.claudecodegui.notifications.ClaudeNotifier.setAgent(context.getProject(), agentName);
                } else {
                    com.github.claudecodegui.notifications.ClaudeNotifier.setAgent(context.getProject(), "");
                }
            } else {
                com.github.claudecodegui.notifications.ClaudeNotifier.setAgent(context.getProject(), "");
            }

            String resultJson = gson.toJson(result);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.onSelectedAgentChanged", escapeJs(resultJson));
            });
        } catch (Exception e) {
            LOG.error("[AgentHandler] Failed to set selected agent: " + e.getMessage(), e);
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("error", e.getMessage());
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.onSelectedAgentChanged", escapeJs(gson.toJson(errorResult)));
            });
        }
    }

    /**
     * Export selected agents to a JSON file.
     */
    private void handleExportAgents(String content) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                List<JsonObject> agents = settingsService.getAgents();

                // Filter agents by selected IDs if provided
                if (content != null && !content.isEmpty()) {
                    try {
                        JsonObject data = gson.fromJson(content, JsonObject.class);
                        if (data.has("agentIds")) {
                            JsonArray agentIdsArray = data.getAsJsonArray("agentIds");
                            java.util.Set<String> selectedIds = new java.util.HashSet<>();
                            for (int i = 0; i < agentIdsArray.size(); i++) {
                                selectedIds.add(agentIdsArray.get(i).getAsString());
                            }

                            agents = agents.stream()
                                .filter(agent -> {
                                    String id = agent.has("id") ? agent.get("id").getAsString() : "";
                                    return selectedIds.contains(id);
                                })
                                .collect(java.util.stream.Collectors.toList());
                        }
                    } catch (Exception e) {
                        LOG.warn("[AgentHandler] Failed to parse agentIds, exporting all: " + e.getMessage());
                    }
                }

                SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
                String exportTime = dateFormat.format(new Date());

                JsonObject exportData = new JsonObject();
                exportData.addProperty("format", "claude-code-agents-export-v1");
                exportData.addProperty("exportTime", exportTime);
                exportData.addProperty("agentCount", agents.size());

                JsonArray agentsArray = new JsonArray();
                for (JsonObject agent : agents) {
                    agentsArray.add(agent);
                }
                exportData.add("agents", agentsArray);

                String projectPath = context.getProject().getBasePath();
                FileDialog fileDialog = new FileDialog((Frame) null, "Export Agents", FileDialog.SAVE);

                if (projectPath != null) {
                    fileDialog.setDirectory(projectPath);
                }

                SimpleDateFormat filenameDateFormat = new SimpleDateFormat("yyyyMMdd-HHmmss");
                String defaultFilename = "agents-" + filenameDateFormat.format(new Date()) + ".json";
                fileDialog.setFile(defaultFilename);

                fileDialog.setFilenameFilter((dir, name) -> name.toLowerCase().endsWith(".json"));
                fileDialog.setVisible(true);

                String selectedDir = fileDialog.getDirectory();
                String selectedFile = fileDialog.getFile();

                if (selectedDir != null && selectedFile != null) {
                    File fileToSave = new File(selectedDir, selectedFile);

                    String path = fileToSave.getAbsolutePath();
                    if (!path.toLowerCase().endsWith(".json")) {
                        fileToSave = new File(path + ".json");
                    }

                    try (FileWriter writer = new FileWriter(fileToSave, StandardCharsets.UTF_8)) {
                        gson.toJson(exportData, writer);
                        LOG.info("[AgentHandler] Successfully exported " + agents.size() + " agents to: " + fileToSave.getAbsolutePath());

                        com.github.claudecodegui.notifications.ClaudeNotifier.showSuccess(
                                context.getProject(),
                                "Exported " + agents.size() + " agents to " + fileToSave.getName()
                        );
                    }
                } else {
                    LOG.info("[AgentHandler] Export cancelled by user");
                }
            } catch (Exception e) {
                LOG.error("[AgentHandler] Failed to export agents: " + e.getMessage(), e);
                com.github.claudecodegui.notifications.ClaudeNotifier.showError(
                        context.getProject(),
                        "Failed to export agents: " + e.getMessage()
                );
            }
        });
    }

    /**
     * Open file chooser to select agents JSON file for import.
     */
    private void handleImportAgentsFile() {
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
                descriptor.setTitle("Import Agents");
                descriptor.setDescription("Select a JSON file containing exported agents");
                descriptor.withFileFilter(file -> file.getExtension() != null && file.getExtension().equalsIgnoreCase("json"));

                // Set initial directory to project base path
                VirtualFile initialDir = null;
                String projectPath = context.getProject().getBasePath();
                if (projectPath != null) {
                    initialDir = LocalFileSystem.getInstance().findFileByPath(projectPath);
                }

                // Show file chooser
                VirtualFile[] selectedFiles = FileChooser.chooseFiles(descriptor, context.getProject(), initialDir);

                if (selectedFiles.length > 0) {
                    VirtualFile selectedFile = selectedFiles[0];
                    File fileToImport = new File(selectedFile.getPath());

                    if (!fileToImport.exists() || !fileToImport.canRead()) {
                        throw new Exception("File not found or cannot be read: " + fileToImport.getAbsolutePath());
                    }

                    long fileSize = fileToImport.length();
                    if (fileSize > 5 * 1024 * 1024) {
                        throw new Exception("File too large (> 5MB). Please reduce the number of items.");
                    }

                    String content = new String(Files.readAllBytes(fileToImport.toPath()), StandardCharsets.UTF_8);
                    JsonObject importData = gson.fromJson(content, JsonObject.class);

                    if (!importData.has("format") || !importData.get("format").getAsString().equals("claude-code-agents-export-v1")) {
                        throw new Exception("Invalid file format. Expected claude-code-agents-export-v1");
                    }

                    if (!importData.has("agents")) {
                        throw new Exception("Invalid file: missing 'agents' field");
                    }

                    JsonArray agentsArray = importData.getAsJsonArray("agents");
                    List<JsonObject> agentsToImport = new java.util.ArrayList<>();
                    for (int i = 0; i < agentsArray.size(); i++) {
                        agentsToImport.add(agentsArray.get(i).getAsJsonObject());
                    }

                    java.util.Set<String> conflicts = settingsService.getAgentManager().detectConflicts(agentsToImport);

                    JsonObject previewResult = new JsonObject();
                    JsonArray previewItems = new JsonArray();

                    for (JsonObject agent : agentsToImport) {
                        JsonObject previewItem = new JsonObject();
                        previewItem.add("data", agent);

                        String id = agent.has("id") ? agent.get("id").getAsString() : "";
                        boolean hasConflict = conflicts.contains(id);
                        previewItem.addProperty("status", hasConflict ? "update" : "new");
                        previewItem.addProperty("conflict", hasConflict);

                        previewItems.add(previewItem);
                    }

                    previewResult.add("items", previewItems);
                    JsonObject summary = new JsonObject();
                    summary.addProperty("total", agentsToImport.size());
                    summary.addProperty("newCount", agentsToImport.size() - conflicts.size());
                    summary.addProperty("updateCount", conflicts.size());
                    previewResult.add("summary", summary);

                    String resultJson = gson.toJson(previewResult);
                    callJavaScript("window.agentImportPreviewResult", escapeJs(resultJson));
                } else {
                    LOG.info("[AgentHandler] Import cancelled by user");
                }
            } catch (Exception e) {
                LOG.error("[AgentHandler] Failed to import agents file: " + e.getMessage(), e);
                com.github.claudecodegui.notifications.ClaudeNotifier.showError(
                        context.getProject(),
                        "Failed to load import file: " + e.getMessage()
                );
            }
        });
    }

    /**
     * Save imported agents with conflict resolution.
     */
    private void handleSaveImportedAgents(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);

            if (!data.has("agents") || !data.has("strategy")) {
                throw new Exception("Missing required fields: agents or strategy");
            }

            JsonArray agentsArray = data.getAsJsonArray("agents");
            String strategyValue = data.get("strategy").getAsString();
            ConflictStrategy strategy = ConflictStrategy.fromValue(strategyValue);

            List<JsonObject> agentsToImport = new java.util.ArrayList<>();
            for (int i = 0; i < agentsArray.size(); i++) {
                agentsToImport.add(agentsArray.get(i).getAsJsonObject());
            }

            Map<String, Object> result = settingsService.getAgentManager().batchImportAgents(agentsToImport, strategy);

            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetAgents();

                int imported = (int) result.get("imported");
                int updated = (int) result.get("updated");
                int skipped = (int) result.get("skipped");

                String message = String.format("Imported %d agents (%d new, %d updated, %d skipped)",
                        imported + updated, imported, updated, skipped);

                com.github.claudecodegui.notifications.ClaudeNotifier.showSuccess(
                        context.getProject(),
                        message
                );

                JsonObject importResult = new JsonObject();
                importResult.addProperty("success", (boolean) result.get("success"));
                importResult.addProperty("imported", imported);
                importResult.addProperty("updated", updated);
                importResult.addProperty("skipped", skipped);

                callJavaScript("window.agentImportResult", escapeJs(gson.toJson(importResult)));
            });
        } catch (Exception e) {
            LOG.error("[AgentHandler] Failed to save imported agents: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                com.github.claudecodegui.notifications.ClaudeNotifier.showError(
                        context.getProject(),
                        "Failed to import agents: " + e.getMessage()
                );

                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("success", false);
                errorResult.addProperty("error", e.getMessage());
                callJavaScript("window.agentImportResult", escapeJs(gson.toJson(errorResult)));
            });
        }
    }
}

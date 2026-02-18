package com.github.claudecodegui.handler;

import com.github.claudecodegui.CodemossSettingsService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.util.List;

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
        "set_selected_agent"
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
}

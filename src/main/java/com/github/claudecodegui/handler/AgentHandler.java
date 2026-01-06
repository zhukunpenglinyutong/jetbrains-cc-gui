package com.github.claudecodegui.handler;

import com.github.claudecodegui.CodemossSettingsService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.util.List;

/**
 * Agent 智能体管理消息处理器
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
     * 获取所有智能体
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
     * 添加智能体
     */
    private void handleAddAgent(String content) {
        try {
            JsonObject agent = gson.fromJson(content, JsonObject.class);
            settingsService.addAgent(agent);

            // 刷新列表
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
     * 更新智能体
     */
    private void handleUpdateAgent(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();
            JsonObject updates = data.getAsJsonObject("updates");

            settingsService.updateAgent(id, updates);

            // 刷新列表
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
     * 删除智能体
     */
    private void handleDeleteAgent(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();

            boolean deleted = settingsService.deleteAgent(id);

            if (deleted) {
                // 如果删除的是当前选中的智能体，清空选中状态
                try {
                    String selectedId = settingsService.getSelectedAgentId();
                    if (id.equals(selectedId)) {
                        settingsService.setSelectedAgentId(null);
                        // 通知前端清空选中状态
                        callJavaScript("window.onSelectedAgentChanged", escapeJs("null"));
                    }
                } catch (Exception e) {
                    LOG.warn("[AgentHandler] Failed to check/clear selected agent: " + e.getMessage());
                }

                // 刷新列表
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
     * 获取当前选中的智能体
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
                    // 智能体已被删除，清空选中状态
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
     * 设置选中的智能体
     */
    private void handleSetSelectedAgent(String content) {
        try {
            String agentId = null;

            // 处理空内容（取消选择智能体）
            if (content != null && !content.isEmpty() && !content.equals("null")) {
                JsonObject data = gson.fromJson(content, JsonObject.class);
                if (data != null) {
                    // 兼容两种字段名：前端发送 "id"，但也支持 "agentId"
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

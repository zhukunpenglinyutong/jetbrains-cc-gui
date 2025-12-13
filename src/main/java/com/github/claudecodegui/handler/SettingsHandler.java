package com.github.claudecodegui.handler;

import com.github.claudecodegui.ClaudeHistoryReader;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;

import javax.swing.*;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * 设置和使用统计相关消息处理器
 */
public class SettingsHandler extends BaseMessageHandler {

    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";

    private static final String[] SUPPORTED_TYPES = {
        "set_mode",
        "set_model",
        "set_provider",
        "get_node_path",
        "set_node_path",
        "get_usage_statistics"
    };

    // 默认模型上下文限制（当无法从远程获取时使用）
    private static final Map<String, Integer> MODEL_CONTEXT_LIMITS = new HashMap<>();
    static {
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-5", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-4-5-20251101", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-haiku-4-5", 200_000);
    }

    // 默认上下文限制（用于未知模型）
    private static final int DEFAULT_CONTEXT_LIMIT = 200_000;

    public SettingsHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "set_mode":
                handleSetMode(content);
                return true;
            case "set_model":
                handleSetModel(content);
                return true;
            case "set_provider":
                handleSetProvider(content);
                return true;
            case "get_node_path":
                handleGetNodePath();
                return true;
            case "set_node_path":
                handleSetNodePath(content);
                return true;
            case "get_usage_statistics":
                handleGetUsageStatistics(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * 处理设置模式请求
     */
    private void handleSetMode(String content) {
        try {
            String mode = content;
            if (content != null && !content.isEmpty()) {
                try {
                    Gson gson = new Gson();
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("mode")) {
                        mode = json.get("mode").getAsString();
                    }
                } catch (Exception e) {
                    // content 本身就是 mode
                }
            }

            System.out.println("[SettingsHandler] Setting permission mode to: " + mode);
            context.getSession().setPermissionMode(mode);
        } catch (Exception e) {
            System.err.println("[SettingsHandler] Failed to set mode: " + e.getMessage());
            e.printStackTrace();
        }
    }

    /**
     * 处理设置模型请求
     * 设置完成后向前端发送确认回调，确保前后端状态同步
     */
    private void handleSetModel(String content) {
        try {
            String model = content;
            if (content != null && !content.isEmpty()) {
                try {
                    Gson gson = new Gson();
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("model")) {
                        model = json.get("model").getAsString();
                    }
                } catch (Exception e) {
                    // content 本身就是 model
                }
            }

            System.out.println("[SettingsHandler] Setting model to: " + model);
            context.setCurrentModel(model);

            if (context.getSession() != null) {
                context.getSession().setModel(model);
            }

            // 向前端发送确认回调，确保前后端状态同步
            final String confirmedModel = model;
            final String confirmedProvider = context.getCurrentProvider();
            SwingUtilities.invokeLater(() -> {
                // 发送模型确认
                callJavaScript("window.onModelConfirmed", escapeJs(confirmedModel), escapeJs(confirmedProvider));
            });
        } catch (Exception e) {
            System.err.println("[SettingsHandler] Failed to set model: " + e.getMessage());
            e.printStackTrace();
        }
    }

    /**
     * 处理设置提供商请求
     */
    private void handleSetProvider(String content) {
        try {
            String provider = content;
            if (content != null && !content.isEmpty()) {
                try {
                    Gson gson = new Gson();
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("provider")) {
                        provider = json.get("provider").getAsString();
                    }
                } catch (Exception e) {
                    // content 本身就是 provider
                }
            }

            System.out.println("[SettingsHandler] Setting provider to: " + provider);
            context.setCurrentProvider(provider);

            if (context.getSession() != null) {
                context.getSession().setProvider(provider);
            }
        } catch (Exception e) {
            System.err.println("[SettingsHandler] Failed to set provider: " + e.getMessage());
            e.printStackTrace();
        }
    }

    /**
     * 获取 Node.js 路径
     */
    private void handleGetNodePath() {
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String saved = props.getValue(NODE_PATH_PROPERTY_KEY);
            String effectivePath;
            if (saved != null && !saved.trim().isEmpty()) {
                effectivePath = saved.trim();
            } else {
                String detected = context.getClaudeSDKBridge().getNodeExecutable();
                effectivePath = detected != null ? detected : "";
            }
            final String pathToSend = effectivePath != null ? effectivePath : "";
            SwingUtilities.invokeLater(() -> {
                callJavaScript("window.updateNodePath", escapeJs(pathToSend));
            });
        } catch (Exception e) {
            System.err.println("[SettingsHandler] Failed to get Node.js path: " + e.getMessage());
            e.printStackTrace();
        }
    }

    /**
     * 设置 Node.js 路径
     */
    private void handleSetNodePath(String content) {
        System.out.println("[SettingsHandler] ========== handleSetNodePath START ==========");
        System.out.println("[SettingsHandler] Received content: " + content);
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String path = null;
            if (json != null && json.has("path") && !json.get("path").isJsonNull()) {
                path = json.get("path").getAsString();
            }

            if (path != null) {
                path = path.trim();
            }

            PropertiesComponent props = PropertiesComponent.getInstance();
            String effectivePath;
            if (path == null || path.isEmpty()) {
                props.unsetValue(NODE_PATH_PROPERTY_KEY);
                // 同时清除 Claude 和 Codex 的手动配置
                context.getClaudeSDKBridge().setNodeExecutable(null);
                context.getCodexSDKBridge().setNodeExecutable(null);
                System.out.println("[SettingsHandler] Cleared manual Node.js path from settings");
                String detected = context.getClaudeSDKBridge().getNodeExecutable();
                effectivePath = detected != null ? detected : "";
            } else {
                props.setValue(NODE_PATH_PROPERTY_KEY, path);
                // 同时设置 Claude 和 Codex 的 Node.js 路径
                context.getClaudeSDKBridge().setNodeExecutable(path);
                context.getCodexSDKBridge().setNodeExecutable(path);
                System.out.println("[SettingsHandler] Updated manual Node.js path from settings: " + path);
                effectivePath = path;
            }

            final String finalPath = effectivePath != null ? effectivePath : "";
            SwingUtilities.invokeLater(() -> {
                callJavaScript("window.updateNodePath", escapeJs(finalPath));
                callJavaScript("window.showSwitchSuccess", escapeJs("Node.js 路径已保存。\n\n如果环境检查仍然失败，请关闭并重新打开工具窗口后重试。"));
            });
        } catch (Exception e) {
            System.err.println("[SettingsHandler] Failed to set Node.js path: " + e.getMessage());
            e.printStackTrace();
            SwingUtilities.invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("保存 Node.js 路径失败: " + e.getMessage()));
            });
        }
        System.out.println("[SettingsHandler] ========== handleSetNodePath END ==========");
    }

    /**
     * 获取使用统计数据
     */
    private void handleGetUsageStatistics(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                String projectPath = "all";

                if (content != null && !content.isEmpty() && !content.equals("{}")) {
                    try {
                        Gson gson = new Gson();
                        JsonObject json = gson.fromJson(content, JsonObject.class);
                        if (json.has("scope")) {
                            String scope = json.get("scope").getAsString();
                            if ("current".equals(scope)) {
                                projectPath = context.getProject().getBasePath();
                            } else {
                                projectPath = "all";
                            }
                        }
                    } catch (Exception e) {
                        if ("current".equals(content)) {
                            projectPath = context.getProject().getBasePath();
                        } else {
                            projectPath = content;
                        }
                    }
                }

                ClaudeHistoryReader reader = new ClaudeHistoryReader();
                ClaudeHistoryReader.ProjectStatistics stats = reader.getProjectStatistics(projectPath);

                Gson gson = new Gson();
                String json = gson.toJson(stats);

                int totalTokens = 0;
                if (stats != null && stats.totalUsage != null) {
                    totalTokens = stats.totalUsage.inputTokens + stats.totalUsage.outputTokens;
                }
                final int MONTHLY_TOKEN_LIMIT = 5_000_000;
                int percentage = Math.min(100, (int) ((totalTokens * 100.0) / MONTHLY_TOKEN_LIMIT));

                JsonObject usageUpdate = new JsonObject();
                usageUpdate.addProperty("percentage", percentage);
                usageUpdate.addProperty("totalTokens", totalTokens);
                usageUpdate.addProperty("limit", MONTHLY_TOKEN_LIMIT);
                if (stats != null) {
                    usageUpdate.addProperty("estimatedCost", stats.estimatedCost);
                }
                String usageJson = gson.toJson(usageUpdate);

                final String statsJsonFinal = json;

                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.updateUsageStatistics", escapeJs(statsJsonFinal));
                });
            } catch (Exception e) {
                System.err.println("[SettingsHandler] Failed to get usage statistics: " + e.getMessage());
                e.printStackTrace();
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs("获取统计数据失败: " + e.getMessage()));
                });
            }
        });
    }

    /**
     * 获取模型上下文限制
     * 优先从预定义列表获取，如果不存在则根据模型名称推断
     */
    public static int getModelContextLimit(String model) {
        if (model == null || model.isEmpty()) {
            return DEFAULT_CONTEXT_LIMIT;
        }

        // 先检查预定义列表
        if (MODEL_CONTEXT_LIMITS.containsKey(model)) {
            return MODEL_CONTEXT_LIMITS.get(model);
        }

        // 根据模型名称推断上下文限制
        String lowerModel = model.toLowerCase();

        // Claude 3.5 和 4 系列通常有 200K 上下文
        if (lowerModel.contains("claude-3") || lowerModel.contains("claude-4") ||
            lowerModel.contains("sonnet") || lowerModel.contains("opus") || lowerModel.contains("haiku")) {
            return 200_000;
        }

        // 默认返回 200K
        return DEFAULT_CONTEXT_LIMIT;
    }
}

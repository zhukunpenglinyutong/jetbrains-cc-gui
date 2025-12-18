package com.github.claudecodegui.handler;

import com.github.claudecodegui.ClaudeHistoryReader;
import com.github.claudecodegui.ClaudeSession;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.diagnostic.Logger;

import javax.swing.*;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * 设置和使用统计相关消息处理器
 */
public class SettingsHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(SettingsHandler.class);

    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";

    private static final String[] SUPPORTED_TYPES = {
        "set_mode",
        "set_model",
        "set_provider",
        "get_node_path",
        "set_node_path",
        "get_usage_statistics"
    };

    private static final Map<String, Integer> MODEL_CONTEXT_LIMITS = new HashMap<>();
    static {
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-5", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-4-5-20251101", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-haiku-4-5", 200_000);
    }

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

            LOG.info("[SettingsHandler] Setting permission mode to: " + mode);
            context.getSession().setPermissionMode(mode);
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set mode: " + e.getMessage(), e);
        }
    }

    /**
     * 处理设置模型请求
     * 设置完成后向前端发送确认回调，确保前后端状态同步
     *
     * 容量计算优化：当前端选择基础模型（如 claude-sonnet-4-5）时，
     * 会从设置中查找对应的实际模型配置（如 ANTHROPIC_DEFAULT_SONNET_MODEL），
     * 以支持带容量后缀的自定义模型名称（如 claude-sonnet-4-5-20250929[1M]）
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

            LOG.info("[SettingsHandler] Setting model to: " + model);

            // 尝试从设置中获取实际配置的模型名称（支持容量后缀）
            String actualModel = resolveActualModelName(model);
            String finalModelName;
            if (actualModel != null && !actualModel.equals(model)) {
                LOG.info("[SettingsHandler] Resolved to actual model: " + actualModel);
                context.setCurrentModel(actualModel);
                finalModelName = actualModel;
            } else {
                context.setCurrentModel(model);
                finalModelName = model;
            }

            if (context.getSession() != null) {
                context.getSession().setModel(model);
            }

            // 计算新模型的上下文限制
            int newMaxTokens = getModelContextLimit(finalModelName);
            LOG.info("[SettingsHandler] Model context limit: " + newMaxTokens + " tokens for model: " + finalModelName);

            // 向前端发送确认回调，确保前后端状态同步
            final String confirmedModel = model;
            final String confirmedProvider = context.getCurrentProvider();
            SwingUtilities.invokeLater(() -> {
                // 发送模型确认
                callJavaScript("window.onModelConfirmed", escapeJs(confirmedModel), escapeJs(confirmedProvider));

                // 重新计算并推送 usage 更新，确保 maxTokens 根据新模型更新
                pushUsageUpdateAfterModelChange(newMaxTokens);
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set model: " + e.getMessage(), e);
        }
    }

    /**
     * 在模型切换后推送 usage 更新
     * 根据新模型的上下文限制重新计算百分比和 maxTokens
     */
    private void pushUsageUpdateAfterModelChange(int newMaxTokens) {
        try {
            ClaudeSession session = context.getSession();
            if (session == null) {
                // 即使没有会话，也要发送更新让前端知道新的 maxTokens
                sendUsageUpdate(0, newMaxTokens);
                return;
            }

            // 从当前会话中提取最新的 usage 信息
            List<ClaudeSession.Message> messages = session.getMessages();
            JsonObject lastUsage = null;

            for (int i = messages.size() - 1; i >= 0; i--) {
                ClaudeSession.Message msg = messages.get(i);

                if (msg.type != ClaudeSession.Message.Type.ASSISTANT || msg.raw == null) {
                    continue;
                }

                // 检查不同的可能结构
                if (msg.raw.has("message")) {
                    JsonObject message = msg.raw.getAsJsonObject("message");
                    if (message.has("usage")) {
                        lastUsage = message.getAsJsonObject("usage");
                        break;
                    }
                }

                // 检查usage是否在raw的根级别
                if (msg.raw.has("usage")) {
                    lastUsage = msg.raw.getAsJsonObject("usage");
                    break;
                }
            }

            // 计算使用的 tokens
            int inputTokens = lastUsage != null && lastUsage.has("input_tokens") ? lastUsage.get("input_tokens").getAsInt() : 0;
            int cacheWriteTokens = lastUsage != null && lastUsage.has("cache_creation_input_tokens") ? lastUsage.get("cache_creation_input_tokens").getAsInt() : 0;
            int cacheReadTokens = lastUsage != null && lastUsage.has("cache_read_input_tokens") ? lastUsage.get("cache_read_input_tokens").getAsInt() : 0;
            int outputTokens = lastUsage != null && lastUsage.has("output_tokens") ? lastUsage.get("output_tokens").getAsInt() : 0;

            int usedTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;

            // 发送更新
            sendUsageUpdate(usedTokens, newMaxTokens);

        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to push usage update after model change: " + e.getMessage(), e);
        }
    }

    /**
     * 发送 usage 更新到前端
     */
    private void sendUsageUpdate(int usedTokens, int maxTokens) {
        int percentage = Math.min(100, maxTokens > 0 ? (int) ((usedTokens * 100.0) / maxTokens) : 0);

        LOG.info("[SettingsHandler] Sending usage update: usedTokens=" + usedTokens + ", maxTokens=" + maxTokens + ", percentage=" + percentage + "%");

        // 构建 usage 更新数据
        JsonObject usageUpdate = new JsonObject();
        usageUpdate.addProperty("percentage", percentage);
        usageUpdate.addProperty("totalTokens", usedTokens);
        usageUpdate.addProperty("limit", maxTokens);
        usageUpdate.addProperty("usedTokens", usedTokens);
        usageUpdate.addProperty("maxTokens", maxTokens);

        String usageJson = new Gson().toJson(usageUpdate);

        // 推送到前端（必须在 EDT 线程中执行）
        SwingUtilities.invokeLater(() -> {
            if (context.getBrowser() != null && !context.isDisposed()) {
                String js = "(function() {" +
                        "  if (typeof window.onUsageUpdate === 'function') {" +
                        "    window.onUsageUpdate('" + escapeJs(usageJson) + "');" +
                        "  }" +
                        "})();";
                context.getBrowser().getCefBrowser().executeJavaScript(js, context.getBrowser().getCefBrowser().getURL(), 0);
            } else {
                LOG.warn("[SettingsHandler] Cannot send usage update: browser is null or disposed");
            }
        });
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

            LOG.info("[SettingsHandler] Setting provider to: " + provider);
            context.setCurrentProvider(provider);

            if (context.getSession() != null) {
                context.getSession().setProvider(provider);
            }
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set provider: " + e.getMessage(), e);
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
            LOG.error("[SettingsHandler] Failed to get Node.js path: " + e.getMessage(), e);
        }
    }

    /**
     * 设置 Node.js 路径
     */
    private void handleSetNodePath(String content) {
        LOG.debug("[SettingsHandler] ========== handleSetNodePath START ==========");
        LOG.debug("[SettingsHandler] Received content: " + content);
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
                LOG.info("[SettingsHandler] Cleared manual Node.js path from settings");
                String detected = context.getClaudeSDKBridge().getNodeExecutable();
                effectivePath = detected != null ? detected : "";
            } else {
                props.setValue(NODE_PATH_PROPERTY_KEY, path);
                // 同时设置 Claude 和 Codex 的 Node.js 路径
                context.getClaudeSDKBridge().setNodeExecutable(path);
                context.getCodexSDKBridge().setNodeExecutable(path);
                LOG.info("[SettingsHandler] Updated manual Node.js path from settings: " + path);
                effectivePath = path;
            }

            final String finalPath = effectivePath != null ? effectivePath : "";
            SwingUtilities.invokeLater(() -> {
                callJavaScript("window.updateNodePath", escapeJs(finalPath));
                callJavaScript("window.showSwitchSuccess", escapeJs("Node.js 路径已保存。\n\n如果环境检查仍然失败，请关闭并重新打开工具窗口后重试。"));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set Node.js path: " + e.getMessage(), e);
            SwingUtilities.invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("保存 Node.js 路径失败: " + e.getMessage()));
            });
        }
        LOG.debug("[SettingsHandler] ========== handleSetNodePath END ==========");
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
                LOG.error("[SettingsHandler] Failed to get usage statistics: " + e.getMessage(), e);
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs("获取统计数据失败: " + e.getMessage()));
                });
            }
        });
    }

    /**
     * 从设置中解析实际使用的模型名称
     * 支持从 ANTHROPIC_MODEL 或 ANTHROPIC_DEFAULT_*_MODEL 中读取带容量后缀的模型名称
     *
     * @param baseModel 前端选择的基础模型 ID (如 claude-sonnet-4-5, claude-opus-4-5-20251101, claude-haiku-4-5)
     * @return 设置中配置的实际模型名称，如果未配置则返回 null
     */
    private String resolveActualModelName(String baseModel) {
        try {
            com.github.claudecodegui.CodemossSettingsService settingsService =
                new com.github.claudecodegui.CodemossSettingsService();
            com.google.gson.JsonObject config = settingsService.readConfig();

            if (config == null || !config.has("activeProvider")) {
                return null;
            }

            String activeProviderId = config.get("activeProvider").getAsString();
            if (!"claude-code".equals(activeProviderId)) {
                return null;
            }

            if (!config.has("providers") || !config.get("providers").isJsonArray()) {
                return null;
            }

            com.google.gson.JsonArray providers = config.getAsJsonArray("providers");
            for (com.google.gson.JsonElement providerElement : providers) {
                if (!providerElement.isJsonObject()) continue;
                com.google.gson.JsonObject provider = providerElement.getAsJsonObject();

                if (!provider.has("id") || !"claude-code".equals(provider.get("id").getAsString())) {
                    continue;
                }

                if (!provider.has("settingsConfig") || !provider.get("settingsConfig").isJsonObject()) {
                    continue;
                }

                com.google.gson.JsonObject settingsConfig = provider.getAsJsonObject("settingsConfig");
                if (!settingsConfig.has("env") || !settingsConfig.get("env").isJsonObject()) {
                    continue;
                }

                com.google.gson.JsonObject env = settingsConfig.getAsJsonObject("env");

                // 根据基础模型 ID 查找对应的环境变量
                String actualModel = null;

                // 首先检查 ANTHROPIC_MODEL（主模型配置）
                if (env.has("ANTHROPIC_MODEL") && !env.get("ANTHROPIC_MODEL").isJsonNull()) {
                    String mainModel = env.get("ANTHROPIC_MODEL").getAsString();
                    if (mainModel != null && !mainModel.trim().isEmpty()) {
                        actualModel = mainModel.trim();
                    }
                }

                // 如果主模型未配置，根据基础模型 ID 查找对应的默认模型配置
                if (actualModel == null) {
                    if (baseModel.contains("sonnet") && env.has("ANTHROPIC_DEFAULT_SONNET_MODEL")) {
                        actualModel = env.get("ANTHROPIC_DEFAULT_SONNET_MODEL").getAsString();
                    } else if (baseModel.contains("opus") && env.has("ANTHROPIC_DEFAULT_OPUS_MODEL")) {
                        actualModel = env.get("ANTHROPIC_DEFAULT_OPUS_MODEL").getAsString();
                    } else if (baseModel.contains("haiku") && env.has("ANTHROPIC_DEFAULT_HAIKU_MODEL")) {
                        actualModel = env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").getAsString();
                    }
                }

                if (actualModel != null && !actualModel.trim().isEmpty()) {
                    return actualModel.trim();
                }
            }
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to resolve actual model name: " + e.getMessage());
        }

        return null;
    }

    /**
     * 获取模型上下文限制
     * 支持从模型名称中解析容量后缀，例如：
     * - claude-sonnet-4-5[1M] → 1,000,000 tokens
     * - claude-opus-4-5[2M] → 2,000,000 tokens
     * - claude-haiku-4-5[500k] → 500,000 tokens
     * - claude-sonnet-4-5 [1.5M] → 1,500,000 tokens (支持空格和小数)
     * - 支持大小写不敏感 (1m 和 1M 都可以)
     */
    public static int getModelContextLimit(String model) {
        if (model == null || model.isEmpty()) {
            return 200_000;
        }

        // 正则表达式：匹配末尾的 [数字单位]，支持可选空格、小数、大小写
        // 示例: [1M], [2m], [500k], [1.5M], 或带空格的 [1M]
        java.util.regex.Pattern pattern = java.util.regex.Pattern.compile("\\s*\\[([0-9.]+)([kKmM])\\]\\s*$");
        java.util.regex.Matcher matcher = pattern.matcher(model);

        if (matcher.find()) {
            try {
                double value = Double.parseDouble(matcher.group(1));
                String unit = matcher.group(2).toLowerCase();

                if ("m".equals(unit)) {
                    // M (百万) 转换为 tokens
                    return (int)(value * 1_000_000);
                } else if ("k".equals(unit)) {
                    // k (千) 转换为 tokens
                    return (int)(value * 1_000);
                }
            } catch (NumberFormatException e) {
                LOG.error("Failed to parse capacity from model name: " + model);
            }
        }

        // 如果没有容量后缀，尝试从预定义映射中查找
        // 先尝试完整匹配，如果不存在则使用默认值
        return MODEL_CONTEXT_LIMITS.getOrDefault(model, 200_000);
    }
}

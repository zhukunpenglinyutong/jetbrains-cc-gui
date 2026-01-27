package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * MCP Server 管理器
 * 负责管理 MCP 服务器配置
 */
public class McpServerManager {
    private static final Logger LOG = Logger.getInstance(McpServerManager.class);

    private final Gson gson;
    private final Function<Void, JsonObject> configReader;
    private final java.util.function.Consumer<JsonObject> configWriter;
    private final ClaudeSettingsManager claudeSettingsManager;

    public McpServerManager(
            Gson gson,
            Function<Void, JsonObject> configReader,
            java.util.function.Consumer<JsonObject> configWriter,
            ClaudeSettingsManager claudeSettingsManager) {
        this.gson = gson;
        this.configReader = configReader;
        this.configWriter = configWriter;
        this.claudeSettingsManager = claudeSettingsManager;
    }

    /**
     * 获取所有 MCP 服务器
     * 优先从 ~/.claude.json 读取(Claude CLI 标准位置)
     * 回退到 ~/.codemoss/config.json
     *
     * 注意: Claude CLI 会合并全局和项目级别的 disabledMcpServers
     */
    public List<JsonObject> getMcpServers() throws IOException {
        return getMcpServersWithProjectPath(null);
    }

    /**
     * 获取所有 MCP 服务器（支持项目路径）
     * @param projectPath 项目路径，用于读取项目级别的禁用列表
     */
    public List<JsonObject> getMcpServersWithProjectPath(String projectPath) throws IOException {
        List<JsonObject> result = new ArrayList<>();

        // 1. 尝试从 ~/.claude.json 读取(Claude CLI 标准位置)
        try {
            String homeDir = System.getProperty("user.home");
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (claudeJsonFile.exists()) {
                try (FileReader reader = new FileReader(claudeJsonFile)) {
                    JsonObject claudeJson = JsonParser.parseReader(reader).getAsJsonObject();

                    if (claudeJson.has("mcpServers") && claudeJson.get("mcpServers").isJsonObject()) {
                        JsonObject mcpServers = claudeJson.getAsJsonObject("mcpServers");

                        // 读取全局禁用的服务器列表
                        Set<String> disabledServers = new HashSet<>();
                        if (claudeJson.has("disabledMcpServers") && claudeJson.get("disabledMcpServers").isJsonArray()) {
                            JsonArray disabledArray = claudeJson.getAsJsonArray("disabledMcpServers");
                            for (JsonElement elem : disabledArray) {
                                if (elem.isJsonPrimitive()) {
                                    disabledServers.add(elem.getAsString());
                                }
                            }
                        }

                        // 读取项目级别禁用的服务器列表（如果提供了项目路径）
                        if (projectPath != null && claudeJson.has("projects")) {
                            JsonObject projects = claudeJson.getAsJsonObject("projects");
                            if (projects.has(projectPath)) {
                                JsonObject projectConfig = projects.getAsJsonObject(projectPath);
                                if (projectConfig.has("disabledMcpServers")
                                        && projectConfig.get("disabledMcpServers").isJsonArray()) {
                                    JsonArray projectDisabledArray = projectConfig.getAsJsonArray("disabledMcpServers");
                                    for (JsonElement elem : projectDisabledArray) {
                                        if (elem.isJsonPrimitive()) {
                                            disabledServers.add(elem.getAsString());
                                        }
                                    }
                                    LOG.info("[McpServerManager] Merged project-level disabled servers from: " + projectPath);
                                }
                            }
                        }

                        // 将对象格式转换为列表格式
                        for (String serverId : mcpServers.keySet()) {
                            JsonElement serverElem = mcpServers.get(serverId);
                            if (serverElem.isJsonObject()) {
                                JsonObject server = serverElem.getAsJsonObject();

                                // 确保有 id 和 name 字段
                                if (!server.has("id")) {
                                    server.addProperty("id", serverId);
                                }
                                if (!server.has("name")) {
                                    server.addProperty("name", serverId);
                                }

                                // 将 type, command, args, env 等包装到 server 字段中
                                if (!server.has("server")) {
                                    JsonObject serverSpec = new JsonObject();

                                    // 复制所有字段到 server 规格（除了特殊字段）
                                    Set<String> excludedFields = new HashSet<>();
                                    excludedFields.add("id");
                                    excludedFields.add("name");
                                    excludedFields.add("enabled");
                                    excludedFields.add("apps");
                                    excludedFields.add("server");

                                    for (String key : server.keySet()) {
                                        if (!excludedFields.contains(key)) {
                                            serverSpec.add(key, server.get(key));
                                        }
                                    }

                                    server.add("server", serverSpec);
                                }

                                // 设置启用/禁用状态（合并全局和项目级别）
                                boolean isEnabled = !disabledServers.contains(serverId);
                                server.addProperty("enabled", isEnabled);

                                result.add(server);
                            }
                        }

                        LOG.info("[McpServerManager] Loaded " + result.size()
                            + " MCP servers from ~/.claude.json (disabled: " + disabledServers.size() + ")");
                        return result;
                    }
                } catch (Exception e) {
                    LOG.warn("[McpServerManager] Failed to read ~/.claude.json: " + e.getMessage());
                }
            }
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Error accessing ~/.claude.json: " + e.getMessage());
        }

        // 2. 回退到 ~/.codemoss/config.json(数组格式)
        JsonObject config = configReader.apply(null);
        if (config.has("mcpServers")) {
            JsonArray servers = config.getAsJsonArray("mcpServers");
            for (JsonElement elem : servers) {
                if (elem.isJsonObject()) {
                    result.add(elem.getAsJsonObject());
                }
            }
        }

        LOG.info("[McpServerManager] Loaded " + result.size() + " MCP servers from ~/.codemoss/config.json");
        return result;
    }

    /**
     * 更新或插入 MCP 服务器
     * 优先更新 ~/.claude.json(Claude CLI 标准位置)
     * 回退到 ~/.codemoss/config.json
     */
    public void upsertMcpServer(JsonObject server) throws IOException {
        upsertMcpServer(server, null);
    }

    /**
     * 更新或插入 MCP 服务器（支持项目路径）
     * @param projectPath 项目路径，用于更新项目级别 disabledMcpServers（Claude CLI 会合并全局和项目级别禁用列表）
     */
    public void upsertMcpServer(JsonObject server, String projectPath) throws IOException {
        if (!server.has("id")) {
            throw new IllegalArgumentException("Server must have an id");
        }

        String serverId = server.get("id").getAsString();
        boolean isEnabled = !server.has("enabled") || server.get("enabled").getAsBoolean();

        // 1. 尝试更新 ~/.claude.json
        try {
            String homeDir = System.getProperty("user.home");
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (claudeJsonFile.exists()) {
                try (FileReader reader = new FileReader(claudeJsonFile)) {
                    JsonObject claudeJson = JsonParser.parseReader(reader).getAsJsonObject();

                    // 确保 mcpServers 对象存在
                    if (!claudeJson.has("mcpServers") || !claudeJson.get("mcpServers").isJsonObject()) {
                        claudeJson.add("mcpServers", new JsonObject());
                    }
                    JsonObject mcpServers = claudeJson.getAsJsonObject("mcpServers");

                    // 提取 server 规格
                    JsonObject serverSpec;
                    if (server.has("server") && server.get("server").isJsonObject()) {
                        serverSpec = server.getAsJsonObject("server").deepCopy();
                    } else {
                        serverSpec = new JsonObject();
                    }

                    // 如果服务器已存在，合并原有配置（保留未在新配置中指定的字段）
                    if (mcpServers.has(serverId) && mcpServers.get(serverId).isJsonObject()) {
                        JsonObject existingSpec = mcpServers.getAsJsonObject(serverId).deepCopy();
                        // 将新配置合并到原有配置上（新配置覆盖旧配置中的同名字段）
                        for (String key : serverSpec.keySet()) {
                            existingSpec.add(key, serverSpec.get(key));
                        }
                        serverSpec = existingSpec;
                    }

                    // 更新或添加服务器
                    mcpServers.add(serverId, serverSpec);

                    // 更新 disabledMcpServers 列表
                    if (!claudeJson.has("disabledMcpServers") || !claudeJson.get("disabledMcpServers").isJsonArray()) {
                        claudeJson.add("disabledMcpServers", new JsonArray());
                    }
                    JsonArray disabledArray = claudeJson.getAsJsonArray("disabledMcpServers");

                    if (projectPath == null) {
                        JsonArray newDisabled = new JsonArray();
                        for (JsonElement elem : disabledArray) {
                            if (!elem.getAsString().equals(serverId)) {
                                newDisabled.add(elem);
                            }
                        }
                        if (!isEnabled) {
                            newDisabled.add(serverId);
                        }
                        claudeJson.add("disabledMcpServers", newDisabled);
                    } else if (isEnabled) {
                        JsonArray newDisabled = new JsonArray();
                        for (JsonElement elem : disabledArray) {
                            if (!elem.getAsString().equals(serverId)) {
                                newDisabled.add(elem);
                            }
                        }
                        claudeJson.add("disabledMcpServers", newDisabled);
                    }

                    if (projectPath != null) {
                        if (!claudeJson.has("projects") || !claudeJson.get("projects").isJsonObject()) {
                            claudeJson.add("projects", new JsonObject());
                        }
                        JsonObject projects = claudeJson.getAsJsonObject("projects");
                        if (!projects.has(projectPath) || !projects.get(projectPath).isJsonObject()) {
                            projects.add(projectPath, new JsonObject());
                        }
                        JsonObject projectConfig = projects.getAsJsonObject(projectPath);
                        if (!projectConfig.has("disabledMcpServers") || !projectConfig.get("disabledMcpServers").isJsonArray()) {
                            projectConfig.add("disabledMcpServers", new JsonArray());
                        }
                        JsonArray projectDisabledArray = projectConfig.getAsJsonArray("disabledMcpServers");

                        JsonArray newProjectDisabled = new JsonArray();
                        for (JsonElement elem : projectDisabledArray) {
                            if (!elem.getAsString().equals(serverId)) {
                                newProjectDisabled.add(elem);
                            }
                        }
                        if (!isEnabled) {
                            newProjectDisabled.add(serverId);
                        }
                        projectConfig.add("disabledMcpServers", newProjectDisabled);
                    }

                    // 写回文件
                    try (FileWriter writer = new FileWriter(claudeJsonFile)) {
                        gson.toJson(claudeJson, writer);
                        writer.flush();  // 确保数据完全写入磁盘
                    }

                    LOG.info("[McpServerManager] Upserted MCP server in ~/.claude.json: " + serverId
                        + " (enabled: " + isEnabled + ", projectPath: " + (projectPath != null ? projectPath : "(global)") + ")");

                    // 同步到 settings.json（在文件写入完成后）
                    try {
                        claudeSettingsManager.syncMcpToClaudeSettings();
                    } catch (Exception syncError) {
                        LOG.warn("[McpServerManager] Failed to sync MCP to settings.json: " + syncError.getMessage());
                        // 同步失败不应该影响主操作
                    }

                    return;
                }
            }
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Error updating ~/.claude.json: " + e.getMessage());
        }

        // 2. 回退到 ~/.codemoss/config.json
        JsonObject config = configReader.apply(null);
        JsonArray servers;

        if (config.has("mcpServers")) {
            servers = config.getAsJsonArray("mcpServers");
        } else {
            servers = new JsonArray();
            config.add("mcpServers", servers);
        }

        boolean found = false;

        // 查找并更新
        for (int i = 0; i < servers.size(); i++) {
            JsonObject s = servers.get(i).getAsJsonObject();
            if (s.has("id") && s.get("id").getAsString().equals(serverId)) {
                servers.set(i, server); // 替换
                found = true;
                break;
            }
        }

        if (!found) {
            servers.add(server);
        }

        configWriter.accept(config);
        LOG.info("[McpServerManager] Upserted MCP server in ~/.codemoss/config.json: " + serverId);
    }

    /**
     * 删除 MCP 服务器
     * 优先从 ~/.claude.json 删除(Claude CLI 标准位置)
     * 回退到 ~/.codemoss/config.json
     */
    public boolean deleteMcpServer(String serverId) throws IOException {
        boolean removed = false;

        // 1. 尝试从 ~/.claude.json 删除
        try {
            String homeDir = System.getProperty("user.home");
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (claudeJsonFile.exists()) {
                try (FileReader reader = new FileReader(claudeJsonFile)) {
                    JsonObject claudeJson = JsonParser.parseReader(reader).getAsJsonObject();

                    if (claudeJson.has("mcpServers") && claudeJson.get("mcpServers").isJsonObject()) {
                        JsonObject mcpServers = claudeJson.getAsJsonObject("mcpServers");

                        if (mcpServers.has(serverId)) {
                            // 删除服务器
                            mcpServers.remove(serverId);

                            // 同时从 disabledMcpServers 中移除(如果存在)
                            if (claudeJson.has("disabledMcpServers") && claudeJson.get("disabledMcpServers").isJsonArray()) {
                                JsonArray disabledServers = claudeJson.getAsJsonArray("disabledMcpServers");
                                JsonArray newDisabled = new JsonArray();
                                for (JsonElement elem : disabledServers) {
                                    if (!elem.getAsString().equals(serverId)) {
                                        newDisabled.add(elem);
                                    }
                                }
                                claudeJson.add("disabledMcpServers", newDisabled);
                            }

                            // 写回文件
                            try (FileWriter writer = new FileWriter(claudeJsonFile)) {
                                gson.toJson(claudeJson, writer);
                                writer.flush();  // 确保数据完全写入磁盘
                            }

                            LOG.info("[McpServerManager] Deleted MCP server from ~/.claude.json: " + serverId);

                            // 同步到 settings.json（在文件写入完成后）
                            try {
                                claudeSettingsManager.syncMcpToClaudeSettings();
                            } catch (Exception syncError) {
                                LOG.warn("[McpServerManager] Failed to sync MCP to settings.json: " + syncError.getMessage());
                            }

                            removed = true;
                            return true;
                        }
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("[McpServerManager] Error deleting from ~/.claude.json: " + e.getMessage());
        }

        // 2. 回退到 ~/.codemoss/config.json
        JsonObject config = configReader.apply(null);
        if (config.has("mcpServers")) {
            JsonArray servers = config.getAsJsonArray("mcpServers");
            JsonArray newServers = new JsonArray();

            for (JsonElement elem : servers) {
                JsonObject s = elem.getAsJsonObject();
                if (s.has("id") && s.get("id").getAsString().equals(serverId)) {
                    removed = true;
                } else {
                    newServers.add(s);
                }
            }

            if (removed) {
                config.add("mcpServers", newServers);
                configWriter.accept(config);
                LOG.info("[McpServerManager] Deleted MCP server from ~/.codemoss/config.json: " + serverId);
            }
        }

        return removed;
    }

    /**
     * 验证 MCP 服务器配置
     */
    public Map<String, Object> validateMcpServer(JsonObject server) {
        List<String> errors = new ArrayList<>();

        if (!server.has("name") || server.get("name").getAsString().isEmpty()) {
            errors.add("服务器名称不能为空");
        }

        if (server.has("server")) {
            JsonObject serverSpec = server.getAsJsonObject("server");
            String type = serverSpec.has("type") ? serverSpec.get("type").getAsString() : "stdio";

            if ("stdio".equals(type)) {
                if (!serverSpec.has("command") || serverSpec.get("command").getAsString().isEmpty()) {
                    errors.add("命令不能为空");
                }
            } else if ("http".equals(type) || "sse".equals(type)) {
                if (!serverSpec.has("url") || serverSpec.get("url").getAsString().isEmpty()) {
                    errors.add("URL 不能为空");
                } else {
                    String url = serverSpec.get("url").getAsString();
                    try {
                        new java.net.URI(url).toURL();
                    } catch (Exception e) {
                        errors.add("URL 格式无效");
                    }
                }
            } else {
                errors.add("不支持的连接类型: " + type);
            }
        } else {
            errors.add("缺少服务器配置详情");
        }

        Map<String, Object> result = new HashMap<>();
        result.put("valid", errors.isEmpty());
        result.put("errors", errors);
        return result;
    }
}

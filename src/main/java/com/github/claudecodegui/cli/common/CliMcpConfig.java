package com.github.claudecodegui.cli.common;

import com.github.claudecodegui.settings.ConfigPathManager;
import com.github.claudecodegui.settings.RuntimeSharedConfigService;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Per-tab MCP 配置管理。
 * 每个 tab 拥有独立的 MCP 配置文件，通过 --mcp-config 传给 Claude CLI。
 */
public class CliMcpConfig {

    private static final Logger LOG = Logger.getInstance(CliMcpConfig.class);
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    private final String tabId;
    private final Path configPath;
    private final RuntimeSharedConfigService sharedConfigService = new RuntimeSharedConfigService();
    private JsonObject servers = new JsonObject();

    public CliMcpConfig(String tabId) {
        this.tabId = tabId;
        Path base = new ConfigPathManager().getConfigDir().resolve("cli-mcp");
        this.configPath = base.resolve(tabId + ".json");
    }

    /**
     * 从 Claude 全局 settings.json 中的 mcpServers 初始化 per-tab 配置。
     * 如果文件已存在则直接加载。
     */
    public void initialize() {
        try {
            if (Files.exists(configPath)) {
                String content = Files.readString(configPath, StandardCharsets.UTF_8);
                JsonObject existing = GSON.fromJson(content, JsonObject.class);
                if (existing != null) {
                    // 兼容旧格式（纯 servers）和新格式（mcpServers 包裹）
                    if (existing.has("mcpServers") && existing.get("mcpServers").isJsonObject()) {
                        servers = existing.getAsJsonObject("mcpServers");
                    } else {
                        servers = existing;
                    }
                    return;
                }
            }
            servers = sharedConfigService.getSharedMcpServers(null);
            persist();
        } catch (Exception e) {
            LOG.warn("[CliMcpConfig] Failed to initialize MCP config for tab " + tabId, e);
        }
    }

    /** 返回配置文件路径，传给 --mcp-config。 */
    public String getConfigFilePath() {
        return configPath.toAbsolutePath().toString();
    }

    public boolean hasServers() {
        return servers.size() > 0;
    }

    public void cleanup() {
        try {
            Files.deleteIfExists(configPath);
        } catch (Exception ignored) {
        }
    }

    private void persist() {
        try {
            Files.createDirectories(configPath.getParent());
            // Claude CLI --mcp-config 要求 { "mcpServers": { ... } } 格式
            JsonObject wrapper = new JsonObject();
            wrapper.add("mcpServers", servers);
            Files.writeString(configPath, GSON.toJson(wrapper), StandardCharsets.UTF_8);
        } catch (Exception e) {
            LOG.warn("[CliMcpConfig] Failed to persist MCP config: " + e.getMessage());
        }
    }
}

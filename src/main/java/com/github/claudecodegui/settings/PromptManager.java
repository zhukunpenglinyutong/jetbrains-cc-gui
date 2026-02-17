package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Prompt 管理器
 * 负责管理提示词库配置(prompt.json)
 */
public class PromptManager {
    private static final Logger LOG = Logger.getInstance(PromptManager.class);

    private final Gson gson;
    private final ConfigPathManager pathManager;

    public PromptManager(Gson gson, ConfigPathManager pathManager) {
        this.gson = gson;
        this.pathManager = pathManager;
    }

    /**
     * 读取 prompt.json 文件
     */
    public JsonObject readPromptConfig() throws IOException {
        Path promptPath = pathManager.getPromptFilePath();

        if (!Files.exists(promptPath)) {
            // 返回空的配置
            JsonObject config = new JsonObject();
            config.add("prompts", new JsonObject());
            return config;
        }

        try (BufferedReader reader = Files.newBufferedReader(promptPath, StandardCharsets.UTF_8)) {
            JsonObject config = JsonParser.parseReader(reader).getAsJsonObject();
            // 确保 prompts 节点存在
            if (!config.has("prompts")) {
                config.add("prompts", new JsonObject());
            }
            return config;
        } catch (Exception e) {
            LOG.warn("[PromptManager] Failed to read prompt.json: " + e.getMessage());
            JsonObject config = new JsonObject();
            config.add("prompts", new JsonObject());
            return config;
        }
    }

    /**
     * 写入 prompt.json 文件
     */
    public void writePromptConfig(JsonObject config) throws IOException {
        pathManager.ensureConfigDirectory();

        Path promptPath = pathManager.getPromptFilePath();
        try (BufferedWriter writer = Files.newBufferedWriter(promptPath, StandardCharsets.UTF_8)) {
            gson.toJson(config, writer);
            LOG.debug("[PromptManager] Successfully wrote prompt.json");
        } catch (Exception e) {
            LOG.warn("[PromptManager] Failed to write prompt.json: " + e.getMessage());
            throw e;
        }
    }

    /**
     * 获取所有提示词
     * 按创建时间倒序排列(最新的在前)
     */
    public List<JsonObject> getPrompts() throws IOException {
        List<JsonObject> result = new ArrayList<>();
        JsonObject config = readPromptConfig();

        JsonObject prompts = config.getAsJsonObject("prompts");
        for (String key : prompts.keySet()) {
            JsonObject prompt = prompts.getAsJsonObject(key);
            // 确保 ID 存在
            if (!prompt.has("id")) {
                prompt.addProperty("id", key);
            }
            result.add(prompt);
        }

        // 按创建时间倒序排序(最新的在前)
        result.sort((a, b) -> {
            long timeA = a.has("createdAt") ? a.get("createdAt").getAsLong() : 0;
            long timeB = b.has("createdAt") ? b.get("createdAt").getAsLong() : 0;
            return Long.compare(timeB, timeA);
        });

        LOG.debug("[PromptManager] Loaded " + result.size() + " prompts from prompt.json");
        return result;
    }

    /**
     * 添加提示词
     */
    public void addPrompt(JsonObject prompt) throws IOException {
        if (!prompt.has("id")) {
            throw new IllegalArgumentException("Prompt must have an id");
        }

        JsonObject config = readPromptConfig();
        JsonObject prompts = config.getAsJsonObject("prompts");
        String id = prompt.get("id").getAsString();

        // 检查 ID 是否已存在
        if (prompts.has(id)) {
            throw new IllegalArgumentException("Prompt with id '" + id + "' already exists");
        }

        // 添加创建时间
        if (!prompt.has("createdAt")) {
            prompt.addProperty("createdAt", System.currentTimeMillis());
        }

        // 添加提示词
        prompts.add(id, prompt);

        writePromptConfig(config);
        LOG.debug("[PromptManager] Added prompt: " + id);
    }

    /**
     * 更新提示词
     */
    public void updatePrompt(String id, JsonObject updates) throws IOException {
        JsonObject config = readPromptConfig();
        JsonObject prompts = config.getAsJsonObject("prompts");

        if (!prompts.has(id)) {
            throw new IllegalArgumentException("Prompt with id '" + id + "' not found");
        }

        JsonObject prompt = prompts.getAsJsonObject(id);

        // 合并更新
        for (String key : updates.keySet()) {
            // 不允许修改 id 和 createdAt
            if (key.equals("id") || key.equals("createdAt")) {
                continue;
            }

            if (updates.get(key).isJsonNull()) {
                prompt.remove(key);
            } else {
                prompt.add(key, updates.get(key));
            }
        }

        writePromptConfig(config);
        LOG.debug("[PromptManager] Updated prompt: " + id);
    }

    /**
     * 删除提示词
     */
    public boolean deletePrompt(String id) throws IOException {
        JsonObject config = readPromptConfig();
        JsonObject prompts = config.getAsJsonObject("prompts");

        if (!prompts.has(id)) {
            LOG.debug("[PromptManager] Prompt not found: " + id);
            return false;
        }

        // 删除提示词
        prompts.remove(id);

        writePromptConfig(config);
        LOG.debug("[PromptManager] Deleted prompt: " + id);
        return true;
    }

    /**
     * 获取单个提示词
     */
    public JsonObject getPrompt(String id) throws IOException {
        JsonObject config = readPromptConfig();
        JsonObject prompts = config.getAsJsonObject("prompts");

        if (!prompts.has(id)) {
            return null;
        }

        JsonObject prompt = prompts.getAsJsonObject(id);
        if (!prompt.has("id")) {
            prompt.addProperty("id", id);
        }

        return prompt;
    }
}

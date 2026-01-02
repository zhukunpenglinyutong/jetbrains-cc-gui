package com.github.claudecodegui.settings;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * Skill 管理器
 * 负责管理 Skills 配置
 */
public class SkillManager {
    private static final Logger LOG = Logger.getInstance(SkillManager.class);

    private final Function<Void, JsonObject> configReader;
    private final java.util.function.Consumer<JsonObject> configWriter;
    private final ClaudeSettingsManager claudeSettingsManager;

    public SkillManager(
            Function<Void, JsonObject> configReader,
            java.util.function.Consumer<JsonObject> configWriter,
            ClaudeSettingsManager claudeSettingsManager) {
        this.configReader = configReader;
        this.configWriter = configWriter;
        this.claudeSettingsManager = claudeSettingsManager;
    }

    /**
     * 获取所有 Skills 配置
     */
    public List<JsonObject> getSkills() {
        List<JsonObject> result = new ArrayList<>();
        JsonObject config = configReader.apply(null);

        if (!config.has("skills")) {
            return result;
        }

        JsonObject skills = config.getAsJsonObject("skills");
        for (String key : skills.keySet()) {
            JsonObject skill = skills.getAsJsonObject(key);
            // 确保 ID 存在
            if (!skill.has("id")) {
                skill.addProperty("id", key);
            }
            result.add(skill);
        }

        LOG.info("[SkillManager] Loaded " + result.size() + " skills");
        return result;
    }

    /**
     * 添加或更新 Skill
     */
    public void upsertSkill(JsonObject skill) throws IOException {
        if (!skill.has("id")) {
            throw new IllegalArgumentException("Skill must have an id");
        }

        String id = skill.get("id").getAsString();

        // 验证 Skill 配置
        Map<String, Object> validation = validateSkill(skill);
        if (!(boolean) validation.get("valid")) {
            @SuppressWarnings("unchecked")
            List<String> errors = (List<String>) validation.get("errors");
            throw new IllegalArgumentException("Invalid skill configuration: " + String.join(", ", errors));
        }

        JsonObject config = configReader.apply(null);

        // 确保 skills 节点存在
        if (!config.has("skills")) {
            config.add("skills", new JsonObject());
        }

        JsonObject skills = config.getAsJsonObject("skills");

        // 添加或更新 Skill
        skills.add(id, skill);

        // 写入配置
        configWriter.accept(config);

        // 同步到 Claude settings
        syncSkillsToClaudeSettings();

        LOG.info("[SkillManager] Upserted skill: " + id);
    }

    /**
     * 删除 Skill
     */
    public boolean deleteSkill(String id) throws IOException {
        JsonObject config = configReader.apply(null);

        if (!config.has("skills")) {
            LOG.info("[SkillManager] No skills found");
            return false;
        }

        JsonObject skills = config.getAsJsonObject("skills");
        if (!skills.has(id)) {
            LOG.info("[SkillManager] Skill not found: " + id);
            return false;
        }

        // 删除 Skill
        skills.remove(id);

        // 写入配置
        configWriter.accept(config);

        // 同步到 Claude settings
        syncSkillsToClaudeSettings();

        LOG.info("[SkillManager] Deleted skill: " + id);
        return true;
    }

    /**
     * 验证 Skill 配置
     * Skills 是包含 SKILL.md 文件的文件夹,ID 必须是 hyphen-case 格式
     */
    public Map<String, Object> validateSkill(JsonObject skill) {
        List<String> errors = new ArrayList<>();

        // 验证 ID(必须是 hyphen-case:小写字母、数字、连字符)
        if (!skill.has("id") || skill.get("id").isJsonNull() ||
                skill.get("id").getAsString().trim().isEmpty()) {
            errors.add("Skill ID 不能为空");
        } else {
            String id = skill.get("id").getAsString();
            // Skill ID 格式:只允许小写字母、数字、连字符(hyphen-case)
            if (!id.matches("^[a-z0-9-]+$")) {
                errors.add("Skill ID 只能包含小写字母、数字和连字符(hyphen-case)");
            }
        }

        // 验证名称
        if (!skill.has("name") || skill.get("name").isJsonNull() ||
                skill.get("name").getAsString().trim().isEmpty()) {
            errors.add("Skill 名称不能为空");
        }

        // 验证路径(必须是包含 SKILL.md 的文件夹路径)
        if (!skill.has("path") || skill.get("path").isJsonNull() ||
                skill.get("path").getAsString().trim().isEmpty()) {
            errors.add("Skill 路径不能为空");
        }

        // 验证类型(目前只支持 local)
        if (skill.has("type") && !skill.get("type").isJsonNull()) {
            String type = skill.get("type").getAsString();
            if (!"local".equals(type)) {
                errors.add("不支持的 Skill 类型: " + type + "(目前只支持 local)");
            }
        }

        Map<String, Object> result = new java.util.HashMap<>();
        result.put("valid", errors.isEmpty());
        result.put("errors", errors);
        return result;
    }

    /**
     * 同步 Skills 到 Claude settings.json
     * 将启用的 Skills 转换为 SDK plugins 格式
     */
    public void syncSkillsToClaudeSettings() throws IOException {
        List<JsonObject> skills = getSkills();

        // 构建 plugins 数组
        JsonArray plugins = new JsonArray();
        for (JsonObject skill : skills) {
            // 只同步启用的 Skills
            boolean enabled = !skill.has("enabled") || skill.get("enabled").isJsonNull() ||
                    skill.get("enabled").getAsBoolean();
            if (!enabled) {
                continue;
            }

            // 转换为 SDK 的 SdkPluginConfig 格式
            JsonObject plugin = new JsonObject();
            plugin.addProperty("type", "local");
            plugin.addProperty("path", skill.get("path").getAsString());
            plugins.add(plugin);
        }

        // 委托给 ClaudeSettingsManager 进行同步
        claudeSettingsManager.syncSkillsToClaudeSettings(plugins);

        LOG.info("[SkillManager] Synced " + plugins.size() + " enabled skills to Claude settings");
    }
}

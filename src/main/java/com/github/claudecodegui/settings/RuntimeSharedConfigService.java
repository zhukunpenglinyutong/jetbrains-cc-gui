package com.github.claudecodegui.settings;

import com.github.claudecodegui.skill.CodexSkillService;
import com.github.claudecodegui.skill.SharedSkillConfigAggregator;
import com.github.claudecodegui.skill.SkillService;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.util.List;

/**
 * Shared configuration facade.
 * Exposes plugin-managed MCP/skills configuration as plain data for both CLI and SDK runtimes.
 * This service owns configuration aggregation only; runtime environment/process behavior stays separate.
 */
public class RuntimeSharedConfigService {

    private final CodemossSettingsService settingsService;

    public RuntimeSharedConfigService() {
        this(new CodemossSettingsService());
    }

    RuntimeSharedConfigService(CodemossSettingsService settingsService) {
        this.settingsService = settingsService;
    }

    /**
     * Returns plugin-managed MCP configuration in normalized server-id -> server-object form.
     * Supports project-level overrides through the existing plugin settings model.
     */
    public JsonObject getSharedMcpServers(String projectPath) throws IOException {
        List<JsonObject> servers = projectPath != null && !projectPath.isBlank()
                ? settingsService.getMcpServersWithProjectPath(projectPath)
                : settingsService.getMcpServers();

        JsonObject normalized = new JsonObject();
        for (JsonObject server : servers) {
            if (server == null || !server.has("id") || server.get("id").isJsonNull()) {
                continue;
            }
            String id = server.get("id").getAsString();
            if (id == null || id.isBlank()) {
                continue;
            }
            normalized.add(id, server.deepCopy());
        }
        return normalized;
    }

    /**
     * Returns plugin-managed skill metadata together with Claude and Codex runtime projections.
     * This is a read-only aggregation layer; provider-specific enable/delete/import behavior remains unchanged.
     */
    public JsonObject getSharedSkills(String projectPath) throws IOException {
        List<JsonObject> sharedSkills = settingsService.getSkills();
        JsonObject claudeSkills = SkillService.getAllSkills(projectPath);
        JsonObject codexSkills = CodexSkillService.getAllSkills(projectPath);
        return SharedSkillConfigAggregator.aggregate(sharedSkills, claudeSkills, codexSkills);
    }
}

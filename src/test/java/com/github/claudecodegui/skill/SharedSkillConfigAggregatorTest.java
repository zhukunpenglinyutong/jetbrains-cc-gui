package com.github.claudecodegui.skill;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SharedSkillConfigAggregatorTest {

    @Test
    public void aggregatesSharedConfigWithRuntimeProjections() {
        JsonObject shared = new JsonObject();
        shared.addProperty("id", "code-review");
        shared.addProperty("name", "code-review");
        shared.addProperty("description", "Review code");
        shared.addProperty("path", "/shared/code-review");
        shared.addProperty("enabled", true);

        JsonObject claudeSkill = runtimeSkill("claude-global-code-review", "code-review",
                "/home/user/.claude/skills/code-review", true);
        JsonObject claude = scoped("global", "claude-global-code-review", claudeSkill);

        JsonObject codexSkill = runtimeSkill("user:/home/user/.agents/skills/code-review", "code-review",
                "/home/user/.agents/skills/code-review", false);
        JsonObject codex = scoped("user", "user:/home/user/.agents/skills/code-review", codexSkill);

        JsonObject aggregated = SharedSkillConfigAggregator.aggregate(List.of(shared), claude, codex);

        assertTrue(aggregated.has("shared"));
        assertTrue(aggregated.has("projections"));
        assertTrue(aggregated.has("skills"));

        JsonObject sharedEntry = aggregated.getAsJsonObject("shared").getAsJsonObject("code-review");
        assertEquals("plugin", sharedEntry.get("source").getAsString());
        assertTrue(sharedEntry.get("enabled").getAsBoolean());

        JsonObject skill = aggregated.getAsJsonObject("skills").getAsJsonObject("code-review");
        assertEquals("code-review", skill.get("name").getAsString());
        assertTrue(skill.get("shared").getAsBoolean());
        assertTrue(skill.get("enabled").getAsBoolean());
        assertTrue(skill.getAsJsonObject("projections").getAsJsonArray("claude").size() > 0);
        assertTrue(skill.getAsJsonObject("projections").getAsJsonArray("codex").size() > 0);
    }

    @Test
    public void includesRuntimeOnlySkillsWithoutSharedConfig() {
        JsonObject claudeSkill = runtimeSkill("claude-local-local-only", "local-only",
                "/repo/.claude/skills/local-only", true);
        JsonObject claude = scoped("local", "claude-local-local-only", claudeSkill);

        JsonObject aggregated = SharedSkillConfigAggregator.aggregate(List.of(), claude, new JsonObject());

        JsonObject skills = aggregated.getAsJsonObject("skills");
        assertTrue(skills.has("claude:local:local-only"));
        JsonObject skill = skills.getAsJsonObject("claude:local:local-only");
        assertFalse(skill.get("shared").getAsBoolean());
        assertEquals("claude", skill.get("source").getAsString());
    }

    private static JsonObject scoped(String scope, String id, JsonObject skill) {
        JsonObject scoped = new JsonObject();
        JsonObject bucket = new JsonObject();
        bucket.add(id, skill);
        scoped.add(scope, bucket);
        return scoped;
    }

    private static JsonObject runtimeSkill(String id, String name, String path, boolean enabled) {
        JsonObject skill = new JsonObject();
        skill.addProperty("id", id);
        skill.addProperty("name", name);
        skill.addProperty("path", path);
        skill.addProperty("enabled", enabled);
        return skill;
    }
}

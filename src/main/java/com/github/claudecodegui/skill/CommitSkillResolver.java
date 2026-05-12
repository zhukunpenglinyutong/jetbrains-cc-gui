package com.github.claudecodegui.skill;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Resolves commit-generation Skills for the commit message workflow.
 */
public final class CommitSkillResolver {

    public static final String BUILTIN_SKILL_REF = "builtin:git-commit";
    private static final String BUILTIN_SKILL_NAME = "git-commit";
    private static final String BUILTIN_SKILL_DESCRIPTION =
            "Generate exactly one commitlint-compatible Conventional Commits message from a selected git diff.";
    private static final String BUILTIN_SKILL_RESOURCE = "/skills/git-commit.md";
    private static volatile String cachedBuiltinSkillContent;

    private CommitSkillResolver() {
    }

    public static JsonArray buildAvailableSkills(String projectPath, String provider) {
        JsonArray skills = new JsonArray();
        skills.add(createBuiltinSkillOption());

        if (provider == null || provider.trim().isEmpty()) {
            return skills;
        }

        JsonObject discoveredSkills = "codex".equalsIgnoreCase(provider)
                ? CodexSkillService.getAllSkills(projectPath)
                : SkillService.getAllSkills(projectPath);

        String sourceProvider = "codex".equalsIgnoreCase(provider) ? "codex" : "claude";
        appendSkillBucket(skills, discoveredSkills, sourceProvider);
        return skills;
    }

    public static String resolveSkillContent(String skillRef) {
        if (skillRef == null || skillRef.trim().isEmpty() || BUILTIN_SKILL_REF.equals(skillRef.trim())) {
            return readBuiltinSkillContent();
        }

        String normalizedRef = skillRef.trim();
        if (normalizedRef.startsWith("local:")) {
            String pathText = normalizedRef.substring("local:".length()).trim();
            if (!pathText.isEmpty()) {
                try {
                    String content = readLocalSkillContent(Path.of(pathText));
                    if (!content.isEmpty()) {
                        return content;
                    }
                } catch (Exception ignored) {
                    return readBuiltinSkillContent();
                }
            }
            return readBuiltinSkillContent();
        }

        try {
            return readLocalSkillContent(Path.of(normalizedRef));
        } catch (Exception e) {
            return "";
        }
    }

    private static void appendSkillBucket(JsonArray target, JsonObject discoveredSkills, String sourceProvider) {
        if (discoveredSkills == null) {
            return;
        }
        for (String bucketName : discoveredSkills.keySet()) {
            JsonObject bucket = discoveredSkills.getAsJsonObject(bucketName);
            for (String skillKey : bucket.keySet()) {
                JsonObject skill = bucket.getAsJsonObject(skillKey);
                String path = skill.has("path") && !skill.get("path").isJsonNull()
                        ? skill.get("path").getAsString()
                        : null;
                String ref = path == null || path.trim().isEmpty()
                        ? "local:" + skillKey
                        : "local:" + path;
                target.add(toOption(skill, ref, sourceProvider, bucketName));
            }
        }
    }

    private static JsonObject toOption(JsonObject skill, String ref, String sourceProvider, String bucketName) {
        JsonObject option = new JsonObject();
        option.addProperty("ref", ref);
        option.addProperty("name", getString(skill, "name", ref));
        option.addProperty("description", getString(skill, "description", ""));
        option.addProperty("source", sourceProvider);
        option.addProperty("scope", getString(skill, "scope", bucketName));
        option.addProperty("enabled", getBoolean(skill, "enabled", true));
        option.addProperty("builtin", false);
        if (skill.has("path") && !skill.get("path").isJsonNull()) {
            option.addProperty("path", skill.get("path").getAsString());
        }
        if (skill.has("skillPath") && !skill.get("skillPath").isJsonNull()) {
            option.addProperty("skillPath", skill.get("skillPath").getAsString());
        }
        return option;
    }

    private static JsonObject createBuiltinSkillOption() {
        JsonObject option = new JsonObject();
        option.addProperty("ref", BUILTIN_SKILL_REF);
        option.addProperty("name", BUILTIN_SKILL_NAME);
        option.addProperty("description", BUILTIN_SKILL_DESCRIPTION);
        option.addProperty("source", "builtin");
        option.addProperty("scope", "builtin");
        option.addProperty("enabled", true);
        option.addProperty("builtin", true);
        return option;
    }

    private static String readBuiltinSkillContent() {
        String cached = cachedBuiltinSkillContent;
        if (cached != null) {
            return cached;
        }
        try (var input = CommitSkillResolver.class.getResourceAsStream(BUILTIN_SKILL_RESOURCE)) {
            if (input == null) {
                return "";
            }
            String content = new String(input.readAllBytes(), StandardCharsets.UTF_8).trim();
            cachedBuiltinSkillContent = content;
            return content;
        } catch (IOException e) {
            return "";
        }
    }

    private static String readLocalSkillContent(Path path) {
        try {
            if (Files.isDirectory(path)) {
                Path skillMd = SkillFrontmatterParser.locateSkillMd(path);
                if (skillMd == null) {
                    return "";
                }
                return Files.readString(skillMd, StandardCharsets.UTF_8).trim();
            }
            if (Files.isRegularFile(path)) {
                return Files.readString(path, StandardCharsets.UTF_8).trim();
            }
        } catch (IOException e) {
            return "";
        }
        return "";
    }

    private static String getString(JsonObject object, String field, String defaultValue) {
        if (object == null || !object.has(field) || object.get(field).isJsonNull()) {
            return defaultValue;
        }
        String value = object.get(field).getAsString().trim();
        return value.isEmpty() ? defaultValue : value;
    }

    private static boolean getBoolean(JsonObject object, String field, boolean defaultValue) {
        if (object == null || !object.has(field) || object.get(field).isJsonNull()) {
            return defaultValue;
        }
        return object.get(field).getAsBoolean();
    }
}

package com.github.claudecodegui.skill;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class AdditionalDirectoryResolver {

    private static final Logger LOG = Logger.getInstance(AdditionalDirectoryResolver.class);
    // Upper bound on upward directory traversal from cwd toward home.
    // 20 is generous enough for deeply nested workspaces while preventing runaway loops.
    private static final int MAX_UPWARD_TRAVERSAL_DEPTH = 20;

    private AdditionalDirectoryResolver() {
    }

    static List<SlashCommandRegistry.SkillScanDir> getSkillScanDirs(String cwd, String type, String userHome) {
        List<SlashCommandRegistry.SkillScanDir> dirs = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        if (cwd == null || cwd.isEmpty() || type == null || type.isEmpty()) {
            return dirs;
        }

        Path current;
        try {
            current = Paths.get(cwd).toAbsolutePath().normalize();
        } catch (Exception e) {
            LOG.debug("Invalid cwd for skill scanning: " + cwd);
            return dirs;
        }

        Path homePath = null;
        if (userHome != null && !userHome.isEmpty()) {
            try {
                homePath = Paths.get(userHome).toAbsolutePath().normalize();
            } catch (Exception e) {
                LOG.debug("Invalid user home path for skill scanning: " + userHome);
            }
        }

        if (homePath == null) {
            LOG.warn("Cannot determine home directory, skipping upward skill scan");
            return dirs;
        }

        Path fsRoot = current.getRoot();
        int depth = 0;

        while (current != null && !current.equals(fsRoot) && depth < MAX_UPWARD_TRAVERSAL_DEPTH) {
            Path candidate = current.resolve(".claude").resolve(type);
            String normalizedCandidate = SlashCommandPathPolicy.normalizePath(candidate.toString());
            if (Files.isDirectory(candidate) && seen.add(normalizedCandidate)) {
                dirs.add(new SlashCommandRegistry.SkillScanDir(candidate.toString(), "project"));
            }

            if (current.equals(homePath)) {
                break;
            }

            current = current.getParent();
            depth++;
        }

        return dirs;
    }

    static List<String> getAdditionalDirectories(String cwd, String userHome) {
        Set<String> seen = new HashSet<>();
        List<String> result = new ArrayList<>();

        for (JsonObject settings : getMergedClaudeSettings(cwd, userHome)) {
            JsonElement value = settings.get("additionalDirectoriesForClaudeMd");
            if (value == null || value.isJsonNull()) {
                continue;
            }

            if (value.isJsonArray()) {
                for (JsonElement item : value.getAsJsonArray()) {
                    if (item != null && item.isJsonPrimitive()) {
                        addAdditionalDirectory(result, seen, item.getAsString(), cwd);
                    }
                }
            } else if (value.isJsonPrimitive()) {
                addAdditionalDirectory(result, seen, value.getAsString(), cwd);
            }
        }

        return result;
    }

    static String getManagedDirectory(Map<String, String> env, Path policyPath) {
        String fromEnv = env != null ? env.get("CLAUDE_CODE_MANAGED_DIR") : null;
        if (fromEnv != null && !fromEnv.trim().isEmpty()) {
            String normalized = SlashCommandPathPolicy.normalizePath(fromEnv.trim());
            LOG.debug("Managed directory from env: " + normalized);
            return normalized;
        }

        JsonObject policy = SlashCommandJsonReader.readJsonObject(policyPath);
        if (policy == null) {
            return null;
        }

        for (String key : List.of("managedDirectory", "managedSkillsDirectory", "managedDir")) {
            JsonElement value = policy.get(key);
            if (value != null && value.isJsonPrimitive()) {
                String dir = value.getAsString();
                if (dir != null && !dir.trim().isEmpty()) {
                    String normalized = SlashCommandPathPolicy.normalizePath(dir.trim());
                    LOG.debug("Managed directory from policy file: " + normalized);
                    return normalized;
                }
            }
        }

        return null;
    }

    static Path getPolicySettingsPath() {
        if (PlatformUtils.isWindows()) {
            String programData = System.getenv("ProgramData");
            if (programData == null || programData.isEmpty()) {
                programData = "C:\\ProgramData";
            }
            return Paths.get(programData, "ClaudeCode", "managed-settings.json");
        }
        if (PlatformUtils.isMac()) {
            return Paths.get("/Library/Application Support/ClaudeCode/managed-settings.json");
        }
        return Paths.get("/etc/claude-code/managed-settings.json");
    }

    static List<JsonObject> getMergedClaudeSettings(String cwd, String userHome) {
        List<JsonObject> settings = new ArrayList<>();

        if (userHome != null && !userHome.isEmpty()) {
            try {
                Path userSettings = Paths.get(userHome, ".claude", "settings.json");
                JsonObject user = SlashCommandJsonReader.readJsonObject(userSettings);
                if (user != null) {
                    settings.add(user);
                }
            } catch (Exception e) {
                LOG.debug("Invalid user home for settings merge: " + userHome);
            }
        }

        if (cwd != null && !cwd.isEmpty()) {
            try {
                Path cwdPath = Paths.get(cwd).toAbsolutePath().normalize();
                Path projectSettings = cwdPath.resolve(".claude").resolve("settings.json");
                JsonObject project = SlashCommandJsonReader.readJsonObject(projectSettings);
                if (project != null) {
                    settings.add(project);
                }

                Path localSettings = cwdPath.resolve(".claude").resolve("settings.local.json");
                JsonObject local = SlashCommandJsonReader.readJsonObject(localSettings);
                if (local != null) {
                    settings.add(local);
                }
            } catch (Exception e) {
                LOG.debug("Invalid cwd for settings merge: " + cwd);
            }
        }

        return settings;
    }

    static Map<String, Boolean> getEnabledPlugins(String cwd, String userHome) {
        Map<String, Boolean> merged = new HashMap<>();

        for (JsonObject settings : getMergedClaudeSettings(cwd, userHome)) {
            JsonElement enabledPlugins = settings.get("enabledPlugins");
            if (enabledPlugins == null || !enabledPlugins.isJsonObject()) {
                continue;
            }

            JsonObject map = enabledPlugins.getAsJsonObject();
            for (String key : map.keySet()) {
                JsonElement value = map.get(key);
                boolean enabled = value != null && value.isJsonPrimitive() && value.getAsBoolean();
                merged.put(key, enabled);
            }
        }

        return merged;
    }

    private static void addAdditionalDirectory(List<String> result, Set<String> seen, String pathValue, String cwd) {
        if (pathValue == null || pathValue.trim().isEmpty()) {
            return;
        }

        Path path;
        try {
            path = Paths.get(pathValue.trim());
            if (!path.isAbsolute() && cwd != null && !cwd.isEmpty()) {
                path = Paths.get(cwd).resolve(path).normalize();
            }
        } catch (Exception e) {
            LOG.debug("Invalid additional directory path: " + pathValue);
            return;
        }

        Path normalized = path.toAbsolutePath().normalize();
        if (!Files.isDirectory(normalized)) {
            return;
        }

        String key = normalized.toString();
        if (seen.add(key)) {
            result.add(key);
        }
    }
}

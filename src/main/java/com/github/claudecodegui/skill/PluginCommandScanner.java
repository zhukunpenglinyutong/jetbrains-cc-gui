package com.github.claudecodegui.skill;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class PluginCommandScanner {

    private static final Logger LOG = Logger.getInstance(PluginCommandScanner.class);

    private PluginCommandScanner() {
    }

    private record InstalledPlugin(String pluginId, String installPath, String version) {
    }

    static List<SlashCommandRegistry.PluginPath> getPluginPaths(String cwd, String userHome) {
        if (userHome == null || userHome.isEmpty()) {
            return List.of();
        }

        Map<String, Boolean> enabledPlugins = AdditionalDirectoryResolver.getEnabledPlugins(cwd, userHome);
        if (enabledPlugins.isEmpty()) {
            return List.of();
        }

        Path pluginsBase;
        try {
            pluginsBase = Paths.get(userHome, ".claude", "plugins").toAbsolutePath().normalize();
        } catch (Exception e) {
            LOG.warn("Invalid user home path for plugin scanning: " + userHome);
            return List.of();
        }

        Map<String, InstalledPlugin> installedPlugins = getInstalledPlugins(pluginsBase);
        Map<String, String> knownMarketplaces = SlashCommandJsonReader.readKnownMarketplaces(userHome);

        List<SlashCommandRegistry.PluginPath> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        for (Map.Entry<String, Boolean> entry : enabledPlugins.entrySet()) {
            if (!Boolean.TRUE.equals(entry.getValue())) {
                continue;
            }

            String pluginId = entry.getKey();
            if (!SlashCommandPathPolicy.isSafePluginId(pluginId)) {
                LOG.warn("Rejected unsafe plugin ID: " + pluginId);
                continue;
            }

            // Plugin IDs follow the format "name@marketplace".
            // If no '@' is present, the entire ID is treated as the plugin name
            // with no marketplace association.
            int atIndex = pluginId.indexOf('@');
            String pluginName = atIndex >= 0 ? pluginId.substring(0, atIndex) : pluginId;
            String marketplaceId = atIndex >= 0 ? pluginId.substring(atIndex + 1) : null;
            InstalledPlugin installed = installedPlugins.get(pluginId);
            Path pluginDir = installed != null && installed.installPath() != null
                    ? SlashCommandPathPolicy.toNormalizedPath(installed.installPath())
                    : null;
            if (pluginDir == null) {
                pluginDir = pluginsBase.resolve(pluginId).toAbsolutePath().normalize();
            }

            Path manifestPath = SlashCommandPathPolicy.resolvePluginManifestPath(pluginDir);
            if (manifestPath == null && marketplaceId != null) {
                manifestPath = SlashCommandPathPolicy.resolveMarketplaceManifestPath(
                        pluginName, marketplaceId, knownMarketplaces);
            }

            JsonObject manifest = null;
            if (manifestPath != null && Files.isRegularFile(manifestPath)) {
                manifest = SlashCommandJsonReader.readJsonObject(manifestPath);
            }

            List<String> skillsPaths = extractDeclaredPaths(manifest, "skills");
            if (skillsPaths.isEmpty()) {
                skillsPaths = List.of("skills");
            }

            List<String> commandsPaths = extractDeclaredPaths(manifest, "commands");
            if (commandsPaths.isEmpty()) {
                commandsPaths = List.of("commands");
            }

            addResolvedPluginPaths(result, seen, pluginDir, pluginName, pluginId, skillsPaths, "skills");
            addResolvedPluginPaths(result, seen, pluginDir, pluginName, pluginId, commandsPaths, "commands");
        }

        LOG.debug("Discovered plugin paths: " + result.size());
        return result;
    }

    static List<SlashCommandRegistry.SlashCommand> scanPluginSkills(
            List<SlashCommandRegistry.PluginPath> pluginPaths,
            String currentFilePath
    ) {
        if (pluginPaths.isEmpty()) {
            return List.of();
        }

        Map<String, SlashCommandRegistry.SlashCommand> merged = new LinkedHashMap<>();
        Path currentFile = SlashCommandPathPolicy.toNormalizedPath(currentFilePath);
        for (SlashCommandRegistry.PluginPath pluginPath : pluginPaths) {
            if (!"skills".equals(pluginPath.type())) {
                continue;
            }
            List<SlashCommandRegistry.SlashCommand> commands = SlashCommandRegistry.scanSkillsAsCommands(
                    pluginPath.path(),
                    "plugin",
                    pluginPath.pluginName(),
                    currentFile
            );
            for (SlashCommandRegistry.SlashCommand cmd : commands) {
                merged.put(cmd.name(), cmd);
            }
        }

        return new ArrayList<>(merged.values());
    }

    static List<SlashCommandRegistry.SlashCommand> scanPluginCommands(
            List<SlashCommandRegistry.PluginPath> pluginPaths
    ) {
        if (pluginPaths.isEmpty()) {
            return List.of();
        }

        Map<String, SlashCommandRegistry.SlashCommand> merged = new LinkedHashMap<>();
        for (SlashCommandRegistry.PluginPath pluginPath : pluginPaths) {
            if (!"commands".equals(pluginPath.type())) {
                continue;
            }
            List<SlashCommandRegistry.SlashCommand> commands = SlashCommandRegistry.scanCommandsAsCommands(
                    pluginPath.path(),
                    "plugin:" + pluginPath.pluginName()
            );
            for (SlashCommandRegistry.SlashCommand cmd : commands) {
                String cmdName = cmd.name();
                String baseName = cmdName.startsWith("/") ? cmdName.substring(1) : cmdName;
                String prefixedName = "/" + pluginPath.pluginName() + ":" + baseName;
                SlashCommandRegistry.SlashCommand prefixed = new SlashCommandRegistry.SlashCommand(
                        prefixedName,
                        cmd.description(),
                        cmd.source()
                );
                merged.put(prefixed.name(), prefixed);
            }
        }

        return new ArrayList<>(merged.values());
    }

    private static List<String> extractDeclaredPaths(JsonObject manifest, String type) {
        if (manifest == null) {
            return List.of();
        }

        Set<String> paths = new LinkedHashSet<>();

        JsonElement singlePath = manifest.get(type + "Path");
        if (singlePath != null && singlePath.isJsonPrimitive()) {
            paths.add(singlePath.getAsString());
        }

        JsonElement multiPaths = manifest.get(type + "Paths");
        if (multiPaths != null && multiPaths.isJsonArray()) {
            for (JsonElement item : multiPaths.getAsJsonArray()) {
                if (item != null && item.isJsonPrimitive()) {
                    paths.add(item.getAsString());
                }
            }
        }

        JsonElement bareField = manifest.get(type);
        if (bareField != null) {
            if (bareField.isJsonPrimitive()) {
                paths.add(bareField.getAsString());
            } else if (bareField.isJsonArray()) {
                for (JsonElement item : bareField.getAsJsonArray()) {
                    if (item != null && item.isJsonPrimitive()) {
                        paths.add(item.getAsString());
                    }
                }
            }
        }

        return new ArrayList<>(paths);
    }

    private static void addResolvedPluginPaths(
            List<SlashCommandRegistry.PluginPath> result,
            Set<String> seen,
            Path pluginDir,
            String pluginName,
            String pluginId,
            List<String> declaredPaths,
            String type
    ) {
        for (String declaredPath : declaredPaths) {
            if (declaredPath == null || declaredPath.trim().isEmpty()) {
                continue;
            }

            Path resolved = SlashCommandPathPolicy.resolvePluginSubPath(pluginDir, declaredPath.trim());
            if (resolved == null || !SlashCommandPathPolicy.isPluginPathSafe(resolved, pluginDir)) {
                LOG.warn("Rejected plugin " + type + " path: " + declaredPath + " from plugin " + pluginId);
                continue;
            }
            if (!Files.isDirectory(resolved)) {
                LOG.debug("Plugin " + type + " directory does not exist: " + resolved);
                continue;
            }

            String key = pluginName + "::" + type + "::" + SlashCommandPathPolicy.normalizePath(resolved.toString());
            if (seen.add(key)) {
                result.add(new SlashCommandRegistry.PluginPath(pluginName, resolved.toString(), type));
                LOG.debug("Accepted plugin " + type + " path: " + resolved + " (plugin=" + pluginId + ")");
            }
        }
    }

    private static Map<String, InstalledPlugin> getInstalledPlugins(Path pluginsBase) {
        Map<String, InstalledPlugin> result = new HashMap<>();
        if (pluginsBase == null) {
            return result;
        }

        Path installedPluginsPath = pluginsBase.resolve("installed_plugins.json");
        JsonObject root = SlashCommandJsonReader.readJsonObject(installedPluginsPath);
        if (root == null) {
            return result;
        }

        JsonElement pluginsElement = root.get("plugins");
        if (pluginsElement == null || !pluginsElement.isJsonObject()) {
            return result;
        }

        JsonObject plugins = pluginsElement.getAsJsonObject();
        for (String pluginId : plugins.keySet()) {
            JsonElement versionsElement = plugins.get(pluginId);
            if (versionsElement == null || !versionsElement.isJsonArray()) {
                continue;
            }

            JsonArray versions = versionsElement.getAsJsonArray();
            InstalledPlugin fallback = null;
            for (int i = versions.size() - 1; i >= 0; i--) {
                JsonElement versionElement = versions.get(i);
                if (versionElement == null || !versionElement.isJsonObject()) {
                    continue;
                }

                InstalledPlugin candidate = toInstalledPlugin(pluginId, versionElement.getAsJsonObject());
                if (candidate == null) {
                    continue;
                }
                if (fallback == null) {
                    fallback = candidate;
                }
                if (isUsableInstalledPlugin(candidate)) {
                    result.put(pluginId, candidate);
                    fallback = null;
                    break;
                }
            }

            if (fallback != null) {
                result.put(pluginId, fallback);
            }
        }

        return result;
    }

    private static InstalledPlugin toInstalledPlugin(String pluginId, JsonObject versionObj) {
        JsonElement installPathElement = versionObj.get("installPath");
        if (installPathElement == null || !installPathElement.isJsonPrimitive()) {
            return null;
        }

        String installPath = installPathElement.getAsString();
        if (installPath == null || installPath.trim().isEmpty()) {
            return null;
        }

        String version = versionObj.has("version") && versionObj.get("version").isJsonPrimitive()
                ? versionObj.get("version").getAsString()
                : "";
        return new InstalledPlugin(pluginId, installPath, version);
    }

    private static boolean isUsableInstalledPlugin(InstalledPlugin plugin) {
        Path installDir = SlashCommandPathPolicy.toNormalizedPath(plugin.installPath());
        return installDir != null && Files.isDirectory(installDir);
    }
}

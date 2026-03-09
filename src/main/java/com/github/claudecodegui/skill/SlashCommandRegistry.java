package com.github.claudecodegui.skill;

import com.github.claudecodegui.CodexSkillService;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;
import org.snakeyaml.engine.v2.api.Load;
import org.snakeyaml.engine.v2.api.LoadSettings;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Merges built-in slash commands with skill-derived commands per provider.
 * Produces a deduplicated command list in the same JSON format as the SDK.
 */
public final class SlashCommandRegistry {

    private static final Logger LOG = Logger.getInstance(SlashCommandRegistry.class);

    private SlashCommandRegistry() {
    }

    /**
     * A slash command with name (including / prefix), description, and source.
     */
    public record SlashCommand(String name, String description, String source) {
    }

    /**
     * Represents a directory to scan for skills or commands, with its scope.
     */
    public record SkillScanDir(String path, String scope) {
    }

    /**
     * Represents plugin-contributed skill or command directory info.
     */
    public record PluginPath(String pluginName, String path, String type) {
    }

    /**
     * Installed plugin descriptor from installed_plugins.json.
     */
    private record InstalledPlugin(String pluginId, String installPath, String version) {
    }

    // Security constants
    private static final int MAX_UPWARD_TRAVERSAL_DEPTH = 20;
    private static final long MAX_JSON_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
    private static final Pattern SAFE_PLUGIN_ID = Pattern.compile("^[a-zA-Z0-9._@/\\-]+$");
    private static final int MAX_GLOB_PATTERN_LENGTH = 256;
    private static final Pattern DANGEROUS_GLOB = Pattern.compile("(\\*\\*/){5,}");
    private static final int MAX_COMMAND_SCAN_DEPTH = 10;

    // Claude built-in commands (GUI-relevant only; CLI-only and frontend-local ones are excluded)
    public static final List<SlashCommand> CLAUDE_BUILTIN = List.of(
            new SlashCommand("/compact", "Toggle compact mode", "builtin"),
            new SlashCommand("/init", "Initialize a new project", "builtin"),
            new SlashCommand("/review", "Review changes before applying", "builtin")
    );

    // Codex built-in commands (GUI-relevant only; CLI-only ones like /status, /model, /quit are excluded)
    public static final List<SlashCommand> CODEX_BUILTIN = List.of(
            new SlashCommand("/compact", "Summarize conversation to free tokens", "builtin"),
            new SlashCommand("/diff", "Show pending changes diff including untracked files", "builtin"),
            new SlashCommand("/init", "Generate an AGENTS.md scaffold", "builtin"),
            new SlashCommand("/plan", "Switch to plan mode", "builtin"),
            new SlashCommand("/review", "Review working tree changes", "builtin")
    );

    /**
     * Gets the list of directories to scan for Claude skills or commands.
     * Scans from CWD upward to home directory.
     *
     * @param cwd  the current working directory
     * @param type "skills" or "commands"
     * @return list of directories to scan
     */
    public static List<SkillScanDir> getSkillScanDirs(String cwd, String type) {
        return getSkillScanDirs(cwd, type, resolveUserHome());
    }

    /**
     * Gets the list of directories to scan for Claude skills or commands with explicit home path.
     */
    static List<SkillScanDir> getSkillScanDirs(String cwd, String type, String userHome) {
        List<SkillScanDir> dirs = new ArrayList<>();
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

        // Security: if home directory cannot be determined, do not walk upward to filesystem root
        if (homePath == null) {
            LOG.warn("Cannot determine home directory, skipping upward skill scan");
            return dirs;
        }

        Path fsRoot = current.getRoot();
        int depth = 0;

        while (current != null && !current.equals(fsRoot) && depth < MAX_UPWARD_TRAVERSAL_DEPTH) {
            Path candidate = current.resolve(".claude").resolve(type);
            String normalizedCandidate = normalizePath(candidate.toString());
            if (Files.isDirectory(candidate) && seen.add(normalizedCandidate)) {
                dirs.add(new SkillScanDir(candidate.toString(), "project"));
            }

            if (current.equals(homePath)) {
                break;
            }

            current = current.getParent();
            depth++;
        }

        return dirs;
    }

    /**
     * Gets the list of directories to scan for Claude commands.
     *
     * @param cwd the current working directory
     * @return list of directories to scan
     */
    public static List<SkillScanDir> getCommandScanDirs(String cwd) {
        return getSkillScanDirs(cwd, "commands");
    }

    /**
     * Gets the list of directories to scan for Claude skills.
     *
     * @param cwd the current working directory
     * @return list of directories to scan
     */
    public static List<SkillScanDir> getSkillsScanDirs(String cwd) {
        return getSkillScanDirs(cwd, "skills");
    }

    /**
     * Gets configured additional directories for Claude scanning.
     * Reads additionalDirectoriesForClaudeMd from settings.
     *
     * @param cwd current working directory
     * @return validated directories
     */
    public static List<String> getAdditionalDirectories(String cwd) {
        return getAdditionalDirectories(cwd, resolveUserHome());
    }

    /**
     * Gets configured additional directories for Claude scanning with explicit home path.
     */
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

    /**
     * Returns managed directory from env or policy settings file.
     *
     * @return managed directory path, or null if unavailable
     */
    public static String getManagedDirectory() {
        return getManagedDirectory(System.getenv(), getPolicySettingsPath());
    }

    /**
     * Returns managed directory from env or policy settings file.
     */
    static String getManagedDirectory(Map<String, String> env, Path policyPath) {
        String fromEnv = env != null ? env.get("CLAUDE_CODE_MANAGED_DIR") : null;
        if (fromEnv != null && !fromEnv.trim().isEmpty()) {
            String normalized = normalizePath(fromEnv.trim());
            LOG.debug("Managed directory from env: " + normalized);
            return normalized;
        }

        JsonObject policy = readJsonObject(policyPath);
        if (policy == null) {
            return null;
        }

        for (String key : List.of("managedDirectory", "managedSkillsDirectory", "managedDir")) {
            JsonElement value = policy.get(key);
            if (value != null && value.isJsonPrimitive()) {
                String dir = value.getAsString();
                if (dir != null && !dir.trim().isEmpty()) {
                    String normalized = normalizePath(dir.trim());
                    LOG.debug("Managed directory from policy file: " + normalized);
                    return normalized;
                }
            }
        }

        return null;
    }

    /**
     * Scans managed skills directory.
     *
     * @param managedDir managed directory path
     * @param currentFilePath current file path for conditional filtering
     * @return managed slash commands
     */
    public static List<SlashCommand> scanManagedSkills(String managedDir, String currentFilePath) {
        if (managedDir == null || managedDir.isEmpty()) {
            return List.of();
        }

        Path managedPath = Paths.get(managedDir).toAbsolutePath().normalize();
        if (!isManagedPathSafe(managedPath)) {
            LOG.warn("Skipping unsafe managed directory: " + managedPath);
            return List.of();
        }

        Path skillsDir = resolveManagedSkillsDirectory(managedPath);
        if (skillsDir == null) {
            LOG.debug("Managed skills directory not found under: " + managedPath);
            return List.of();
        }

        return scanSkillsAsCommands(skillsDir.toString(), "managed", null, toNormalizedPath(currentFilePath));
    }

    /**
     * Gets plugin paths (skills and commands) from enabled Claude Code plugins.
     *
     * @param cwd current working directory
     * @return plugin paths with type information
     */
    public static List<PluginPath> getPluginPaths(String cwd) {
        return getPluginPaths(cwd, resolveUserHome());
    }

    /**
     * Gets plugin paths from enabled Claude Code plugins with explicit home path.
     */
    static List<PluginPath> getPluginPaths(String cwd, String userHome) {
        if (userHome == null || userHome.isEmpty()) {
            return List.of();
        }

        Map<String, Boolean> enabledPlugins = getEnabledPlugins(cwd, userHome);
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
        Map<String, String> knownMarketplaces = readKnownMarketplaces(userHome);

        List<PluginPath> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        for (Map.Entry<String, Boolean> entry : enabledPlugins.entrySet()) {
            if (!Boolean.TRUE.equals(entry.getValue())) {
                continue;
            }

            String pluginId = entry.getKey();

            // Security: validate plugin ID to prevent path traversal via crafted IDs
            if (!SAFE_PLUGIN_ID.matcher(pluginId).matches() || pluginId.contains("..")) {
                LOG.warn("Rejected unsafe plugin ID: " + pluginId);
                continue;
            }

            String[] idParts = pluginId.split("@", 2);
            String pluginName = idParts[0];
            String marketplaceId = idParts.length > 1 ? idParts[1] : null;
            InstalledPlugin installed = installedPlugins.get(pluginId);
            Path pluginDir = installed != null && installed.installPath() != null
                    ? toNormalizedPath(installed.installPath())
                    : null;
            if (pluginDir == null) {
                pluginDir = pluginsBase.resolve(pluginId).toAbsolutePath().normalize();
            }

            // Try plugin dir manifest first, then marketplace manifest as fallback
            Path manifestPath = resolvePluginManifestPath(pluginDir);
            if (manifestPath == null && marketplaceId != null) {
                manifestPath = resolveMarketplaceManifestPath(
                        pluginName, marketplaceId, knownMarketplaces);
            }

            JsonObject manifest = null;
            if (manifestPath != null && Files.isRegularFile(manifestPath)) {
                manifest = readJsonObject(manifestPath);
            }

            // Extract skills paths
            List<String> skillsPaths = extractDeclaredPaths(manifest, "skills");
            if (skillsPaths.isEmpty()) {
                skillsPaths = List.of("skills");
            }

            // Extract commands paths
            List<String> commandsPaths = extractDeclaredPaths(manifest, "commands");
            if (commandsPaths.isEmpty()) {
                commandsPaths = List.of("commands");
            }

            // Resolve and add skills paths
            addResolvedPluginPaths(result, seen, pluginDir, pluginName, pluginId,
                    skillsPaths, "skills");

            // Resolve and add commands paths
            addResolvedPluginPaths(result, seen, pluginDir, pluginName, pluginId,
                    commandsPaths, "commands");
        }

        LOG.debug("Discovered plugin paths: " + result.size());
        return result;
    }

    /**
     * Extracts declared paths from a plugin manifest for a given type.
     * Normalizes field name variants: type, typePath, typePaths.
     */
    private static List<String> extractDeclaredPaths(JsonObject manifest, String type) {
        if (manifest == null) {
            return List.of();
        }

        // Use LinkedHashSet to deduplicate while preserving insertion order
        Set<String> paths = new LinkedHashSet<>();

        // Check typePath (singular), e.g. skillsPath, commandsPath
        JsonElement singlePath = manifest.get(type + "Path");
        if (singlePath != null && singlePath.isJsonPrimitive()) {
            paths.add(singlePath.getAsString());
        }

        // Check typePaths (plural array), e.g. skillsPaths, commandsPaths
        JsonElement multiPaths = manifest.get(type + "Paths");
        if (multiPaths != null && multiPaths.isJsonArray()) {
            for (JsonElement item : multiPaths.getAsJsonArray()) {
                if (item != null && item.isJsonPrimitive()) {
                    paths.add(item.getAsString());
                }
            }
        }

        // Check bare type name (e.g. "skills", "commands") — marketplace manifest style
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

    /**
     * Resolves and adds plugin paths to the result list with deduplication.
     */
    private static void addResolvedPluginPaths(
            List<PluginPath> result,
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

            Path resolved = resolvePluginSubPath(pluginDir, declaredPath.trim());
            if (resolved == null || !isPluginPathSafe(resolved, pluginDir)) {
                LOG.warn("Rejected plugin " + type + " path: "
                        + declaredPath + " from plugin " + pluginId);
                continue;
            }
            if (!Files.isDirectory(resolved)) {
                LOG.debug("Plugin " + type + " directory does not exist: " + resolved);
                continue;
            }

            String key = pluginName + "::" + type + "::" + normalizePath(resolved.toString());
            if (seen.add(key)) {
                result.add(new PluginPath(pluginName, resolved.toString(), type));
                LOG.debug("Accepted plugin " + type + " path: "
                        + resolved + " (plugin=" + pluginId + ")");
            }
        }
    }

    /**
     * Matches current file against conditional path patterns.
     *
     * @param currentFile current file path
     * @param patterns glob patterns from frontmatter
     * @return true if any pattern matches
     */
    public static boolean matchesPathPatterns(Path currentFile, List<String> patterns) {
        if (patterns == null || patterns.isEmpty()) {
            return true;
        }
        if (currentFile == null) {
            return false;
        }

        String normalized = currentFile.toString().replace('\\', '/');
        for (String pattern : patterns) {
            if (pattern == null || pattern.trim().isEmpty()) {
                continue;
            }

            String trimmed = pattern.trim();

            // Security: validate pattern length and complexity to prevent pathological matching
            if (trimmed.length() > MAX_GLOB_PATTERN_LENGTH) {
                LOG.debug("Pattern too long, skip: " + trimmed.substring(0, 50) + "...");
                continue;
            }
            String patternBody = trimmed.startsWith("glob:") ? trimmed.substring(5) : trimmed;
            if (DANGEROUS_GLOB.matcher(patternBody).find()) {
                LOG.debug("Pattern too complex, skip: " + trimmed);
                continue;
            }

            String candidatePattern = trimmed.startsWith("glob:") ? trimmed : "glob:" + trimmed;

            try {
                PathMatcher matcher = Paths.get("").getFileSystem().getPathMatcher(candidatePattern);
                Path currentPath = Paths.get(normalized);
                if (matcher.matches(currentPath)) {
                    return true;
                }

                Path fileName = currentFile.getFileName();
                if (fileName != null && matcher.matches(fileName)) {
                    return true;
                }

                for (int i = 0; i < currentPath.getNameCount(); i++) {
                    if (matcher.matches(currentPath.subpath(i, currentPath.getNameCount()))) {
                        return true;
                    }
                }
            } catch (Exception e) {
                LOG.debug("Invalid path pattern, skip: " + trimmed);
            }
        }

        return false;
    }

    /**
     * Gets the merged slash command list for a given provider and working directory.
     *
     * @param provider "claude" or "codex"
     * @param cwd current working directory
     * @return deduplicated list of slash commands
     */
    public static List<SlashCommand> getCommands(String provider, String cwd) {
        return getCommands(provider, cwd, null);
    }

    /**
     * Gets the merged slash command list for a given provider and working directory.
     *
     * @param provider "claude" or "codex"
     * @param cwd current working directory
     * @param currentFilePath active editor file path for conditional skills
     * @return deduplicated list of slash commands
     */
    public static List<SlashCommand> getCommands(String provider, String cwd, String currentFilePath) {
        boolean isCodex = "codex".equalsIgnoreCase(provider);

        // Step 1: Select built-in commands by provider
        List<SlashCommand> builtins = isCodex ? CODEX_BUILTIN : CLAUDE_BUILTIN;

        String userHome = resolveUserHome();
        Path currentFile = toNormalizedPath(currentFilePath);

        List<SlashCommand> globalCmdCommands;
        List<SlashCommand> globalSkillCommands;
        List<SlashCommand> localCmdCommands = List.of();
        List<SlashCommand> localSkillCommands = List.of();
        List<SlashCommand> additionalCmdCommands = List.of();
        List<SlashCommand> additionalSkillCommands = List.of();
        List<SlashCommand> managedSkillCommands = List.of();
        List<SlashCommand> pluginSkillCommands = List.of();
        List<SlashCommand> pluginCmdCommands = List.of();

        if (isCodex) {
            // Codex slash commands come only from ~/.codex/prompts/ (namespaced as /prompts:<name>)
            // Codex skills (.agents/skills/) use $ prefix, not / — they are NOT slash commands
            if (userHome.isEmpty()) {
                globalCmdCommands = List.of();
            } else {
                globalCmdCommands = scanPromptsAsCommands(
                        userHome + File.separator + ".codex" + File.separator + "prompts");
            }
            globalSkillCommands = List.of();
        } else {
            if (userHome.isEmpty()) {
                globalCmdCommands = List.of();
                globalSkillCommands = List.of();
            } else {
                String claudeDir = userHome + File.separator + ".claude";
                globalCmdCommands = scanCommandsAsCommands(
                        claudeDir + File.separator + "commands", "user");
                globalSkillCommands = scanSkillsAsCommands(
                        claudeDir + File.separator + "skills", "user", null, currentFile);
            }

            if (cwd != null && !cwd.isEmpty()) {
                List<SkillScanDir> cmdDirs = getCommandScanDirs(cwd);
                List<SkillScanDir> skillDirs = getSkillsScanDirs(cwd);

                localCmdCommands = scanCommandsFromDirs(cmdDirs, "local");
                localSkillCommands = scanSkillsFromDirs(skillDirs, "local", null, currentFile);

                List<String> additionalDirs = getAdditionalDirectories(cwd, userHome);
                additionalCmdCommands = scanAdditionalCommands(additionalDirs);
                additionalSkillCommands = scanAdditionalSkills(additionalDirs, currentFile);
            }

            managedSkillCommands = scanManagedSkills(getManagedDirectory(), currentFilePath);
            List<PluginPath> allPluginPaths = getPluginPaths(cwd, userHome);
            pluginSkillCommands = scanPluginSkills(allPluginPaths, currentFilePath);
            pluginCmdCommands = scanPluginCommands(allPluginPaths);
        }

        // Merge (preserves insertion order, later overrides earlier)
        // Merge order: builtins → local → additional → managed → user → plugin
        return mergeCommandsInOrder(
                builtins,
                localCmdCommands,
                localSkillCommands,
                additionalCmdCommands,
                additionalSkillCommands,
                managedSkillCommands,
                globalCmdCommands,
                globalSkillCommands,
                pluginCmdCommands,
                pluginSkillCommands
        );
    }

    /**
     * Serializes a command list to JSON array format:
     * [{"name": "/help", "description": "...", "source": "..."}, ...]
     */
    public static String toJson(List<SlashCommand> commands) {
        JsonArray array = new JsonArray();
        for (SlashCommand cmd : commands) {
            JsonObject obj = new JsonObject();
            obj.addProperty("name", cmd.name());
            obj.addProperty("description", cmd.description());
            if (cmd.source() != null && !cmd.source().isEmpty()) {
                obj.addProperty("source", cmd.source());
            }
            array.add(obj);
        }
        return new Gson().toJson(array);
    }

    /**
     * Gets Codex skills as $-prefixed commands for autocomplete.
     * Derives from CodexSkillService.getAllSkills() to ensure consistent data
     * with the Skills settings page. Only includes enabled, user-invocable skills.
     */
    public static List<SlashCommand> getCodexSkills(String cwd) {
        JsonObject allSkills = CodexSkillService.getAllSkills(cwd);

        Map<String, SlashCommand> merged = new LinkedHashMap<>();
        for (String scope : new String[]{"user", "repo"}) {
            JsonObject scopeSkills = allSkills.getAsJsonObject(scope);
            if (scopeSkills == null) {
                continue;
            }

            for (String key : scopeSkills.keySet()) {
                JsonObject skill = scopeSkills.getAsJsonObject(key);

                // Skip disabled skills
                if (skill.has("enabled") && !skill.get("enabled").getAsBoolean()) {
                    continue;
                }
                // Skip non-user-invocable skills
                if (skill.has("userInvocable") && !skill.get("userInvocable").getAsBoolean()) {
                    continue;
                }

                String name = skill.has("name") ? skill.get("name").getAsString() : "";
                String desc = skill.has("description") ? skill.get("description").getAsString() : "";
                if (!name.isEmpty()) {
                    merged.put("$" + name, new SlashCommand("$" + name, desc, "codex-skill"));
                }
            }
        }
        return new ArrayList<>(merged.values());
    }

    /**
     * Scans multiple skill directories and returns aggregated slash commands.
     * Child directories keep precedence over parent directories.
     */
    private static List<SlashCommand> scanSkillsFromDirs(
            List<SkillScanDir> scanDirs,
            String source,
            String namespacePrefix,
            Path currentFilePath
    ) {
        Map<String, SlashCommand> merged = new LinkedHashMap<>();
        for (SkillScanDir scanDir : scanDirs) {
            List<SlashCommand> commands = scanSkillsAsCommands(
                    scanDir.path(), source, namespacePrefix, currentFilePath);
            for (SlashCommand cmd : commands) {
                merged.putIfAbsent(cmd.name(), cmd);
            }
        }
        return new ArrayList<>(merged.values());
    }

    /**
     * Scans multiple command directories and returns aggregated slash commands.
     * Child directories keep precedence over parent directories.
     */
    private static List<SlashCommand> scanCommandsFromDirs(List<SkillScanDir> scanDirs, String source) {
        Map<String, SlashCommand> merged = new LinkedHashMap<>();
        for (SkillScanDir scanDir : scanDirs) {
            List<SlashCommand> commands = scanCommandsAsCommands(scanDir.path(), source);
            for (SlashCommand cmd : commands) {
                merged.putIfAbsent(cmd.name(), cmd);
            }
        }
        return new ArrayList<>(merged.values());
    }

    /**
     * Scans additional directories for skills.
     */
    private static List<SlashCommand> scanAdditionalSkills(List<String> additionalDirs, Path currentFilePath) {
        List<SkillScanDir> dirs = new ArrayList<>();
        for (String dir : additionalDirs) {
            Path path = Paths.get(dir).toAbsolutePath().normalize();
            Path candidate = path.resolve(".claude").resolve("skills");
            if (Files.isDirectory(candidate)) {
                dirs.add(new SkillScanDir(candidate.toString(), "additional"));
            }
        }
        return scanSkillsFromDirs(dirs, "additional", null, currentFilePath);
    }

    /**
     * Scans additional directories for commands.
     */
    private static List<SlashCommand> scanAdditionalCommands(List<String> additionalDirs) {
        List<SkillScanDir> dirs = new ArrayList<>();
        for (String dir : additionalDirs) {
            Path path = Paths.get(dir).toAbsolutePath().normalize();
            Path candidate = path.resolve(".claude").resolve("commands");
            if (Files.isDirectory(candidate)) {
                dirs.add(new SkillScanDir(candidate.toString(), "additional"));
            }
        }
        return scanCommandsFromDirs(dirs, "additional");
    }

    /**
     * Scans plugin skill paths and returns plugin-prefixed skill slash commands.
     */
    private static List<SlashCommand> scanPluginSkills(
            List<PluginPath> pluginPaths, String currentFilePath) {
        if (pluginPaths.isEmpty()) {
            return List.of();
        }

        Map<String, SlashCommand> merged = new LinkedHashMap<>();
        Path currentFile = toNormalizedPath(currentFilePath);
        for (PluginPath pluginPath : pluginPaths) {
            if (!"skills".equals(pluginPath.type())) {
                continue;
            }
            List<SlashCommand> commands = scanSkillsAsCommands(
                    pluginPath.path(),
                    "plugin",
                    pluginPath.pluginName(),
                    currentFile
            );
            for (SlashCommand cmd : commands) {
                merged.put(cmd.name(), cmd);
            }
        }

        return new ArrayList<>(merged.values());
    }

    /**
     * Scans plugin command paths and returns plugin-prefixed command slash commands.
     */
    private static List<SlashCommand> scanPluginCommands(List<PluginPath> pluginPaths) {
        if (pluginPaths.isEmpty()) {
            return List.of();
        }

        Map<String, SlashCommand> merged = new LinkedHashMap<>();
        for (PluginPath pluginPath : pluginPaths) {
            if (!"commands".equals(pluginPath.type())) {
                continue;
            }
            List<SlashCommand> commands = scanCommandsAsCommands(
                    pluginPath.path(),
                    "plugin:" + pluginPath.pluginName()
            );
            for (SlashCommand cmd : commands) {
                // Apply plugin namespace prefix: /baseName → /pluginName:baseName
                String cmdName = cmd.name();
                String baseName = cmdName.startsWith("/") ? cmdName.substring(1) : cmdName;
                String prefixedName = "/" + pluginPath.pluginName() + ":" + baseName;
                SlashCommand prefixed = new SlashCommand(
                        prefixedName, cmd.description(), cmd.source());
                merged.put(prefixed.name(), prefixed);
            }
        }

        return new ArrayList<>(merged.values());
    }

    /**
     * Scans a skills directory for valid skill subdirectories and converts them to slash commands.
     * Skips plain files and hidden directories.
     */
    private static List<SlashCommand> scanSkillsAsCommands(
            String dirPath,
            String source,
            String namespacePrefix,
            Path currentFilePath
    ) {
        if (dirPath == null || dirPath.isEmpty()) {
            return List.of();
        }
        File dir = new File(dirPath);
        if (!dir.isDirectory()) {
            return List.of();
        }

        File[] entries = dir.listFiles();
        if (entries == null) {
            return List.of();
        }

        List<SlashCommand> commands = new ArrayList<>();
        for (File entry : entries) {
            // Only process directories, skip files and hidden dirs
            if (!entry.isDirectory() || entry.getName().startsWith(".")) {
                continue;
            }

            SkillFrontmatterParser.SkillMetadata metadata =
                    SkillFrontmatterParser.parse(entry.toPath());
            if (metadata == null) {
                LOG.debug("Skipping skill directory with invalid metadata: " + entry.getName());
                continue;
            }

            // Skills with user-invocable: false are hidden from the slash menu
            if (!metadata.userInvocable()) {
                continue;
            }

            if (!ConditionalSkillFilter.filter(metadata, currentFilePath)) {
                continue;
            }

            String commandName = namespacePrefix != null && !namespacePrefix.isEmpty()
                    ? "/" + namespacePrefix + ":" + metadata.name()
                    : "/" + metadata.name();
            String commandSource = source;
            if ("plugin".equals(source) && namespacePrefix != null && !namespacePrefix.isEmpty()) {
                commandSource = "plugin:" + namespacePrefix;
            }

            commands.add(new SlashCommand(commandName, metadata.description(), commandSource));
        }
        return commands;
    }

    /**
     * Scans a commands directory recursively for .md files and converts them to slash commands.
     * Matches CLI behavior: subdirectory paths become colon-separated namespaces
     * (e.g. opsx/explore.md -> /opsx:explore, a/b/c.md -> /a:b:c).
     * Directories containing SKILL.md are treated as skill leaves and not recursed into.
     */
    private static List<SlashCommand> scanCommandsAsCommands(String dirPath, String source) {
        if (dirPath == null || dirPath.isEmpty()) {
            return List.of();
        }
        Path baseDir = Paths.get(dirPath).toAbsolutePath().normalize();
        if (!Files.isDirectory(baseDir)) {
            return List.of();
        }

        List<SlashCommand> commands = new ArrayList<>();
        scanCommandsRecursive(baseDir.toFile(), baseDir, source, commands, 0);
        return commands;
    }

    /**
     * Recursively scans a directory for command .md files.
     * If a directory contains SKILL.md, reads .md files there without further recursion.
     * Otherwise recurses into subdirectories and reads .md files at current level.
     * Depth is bounded by MAX_COMMAND_SCAN_DEPTH to prevent stack overflow from
     * deeply nested or symlink-looped directory structures.
     */
    private static void scanCommandsRecursive(
            File dir, Path baseDir, String source, List<SlashCommand> commands, int depth) {
        if (depth > MAX_COMMAND_SCAN_DEPTH) {
            LOG.warn("Max command scan depth exceeded, skipping: " + dir);
            return;
        }
        File[] entries = dir.listFiles();
        if (entries == null) {
            return;
        }

        // CLI behavior: if directory contains SKILL.md, treat as skill leaf — read .md files only
        boolean hasSkillMd = false;
        for (File entry : entries) {
            if (entry.isFile() && "skill.md".equalsIgnoreCase(entry.getName())) {
                hasSkillMd = true;
                break;
            }
        }

        for (File entry : entries) {
            if (entry.getName().startsWith(".")) {
                continue;
            }

            if (entry.isFile() && entry.getName().toLowerCase().endsWith(".md")) {
                String namespace = deriveCommandNamespace(entry, baseDir);
                SlashCommand cmd = parseCommandFile(entry, namespace, source);
                if (cmd != null) {
                    commands.add(cmd);
                }
            } else if (entry.isDirectory() && !hasSkillMd) {
                scanCommandsRecursive(entry, baseDir, source, commands, depth + 1);
            }
        }
    }

    /**
     * Derives the colon-separated namespace from a command file's relative path to the base directory.
     * For top-level files returns null; for nested files returns the path components joined by colons.
     * Example: baseDir/opsx/explore.md -> "opsx", baseDir/a/b/c.md -> "a:b".
     */
    private static String deriveCommandNamespace(File mdFile, Path baseDir) {
        Path parent = mdFile.getParentFile().toPath().toAbsolutePath().normalize();
        Path base = baseDir.toAbsolutePath().normalize();
        if (parent.equals(base)) {
            return null;
        }
        Path relative = base.relativize(parent);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < relative.getNameCount(); i++) {
            if (i > 0) {
                sb.append(':');
            }
            sb.append(relative.getName(i));
        }
        return !sb.isEmpty() ? sb.toString() : null;
    }

    /**
     * Scans a Codex prompts directory for .md files and converts them to slash commands.
     * All prompts are namespaced as /prompts:<name> per Codex convention.
     */
    private static List<SlashCommand> scanPromptsAsCommands(String dirPath) {
        if (dirPath == null || dirPath.isEmpty()) {
            return List.of();
        }
        File dir = new File(dirPath);
        if (!dir.isDirectory()) {
            return List.of();
        }

        File[] entries = dir.listFiles();
        if (entries == null) {
            return List.of();
        }

        List<SlashCommand> commands = new ArrayList<>();
        for (File entry : entries) {
            if (!entry.isFile() || !entry.getName().endsWith(".md")
                        || entry.getName().startsWith(".")) {
                continue;
            }
            String baseName = entry.getName().replaceFirst("\\.md$", "");
            String description = extractCommandDescription(entry.toPath());
            commands.add(new SlashCommand(
                    "/prompts:" + baseName,
                    description != null ? description : "",
                    "codex-prompt"));
        }
        return commands;
    }

    /**
     * Parses a single command .md file to extract name and description from frontmatter.
     */
    private static SlashCommand parseCommandFile(File mdFile, String namespace, String source) {
        String baseName = mdFile.getName().replaceFirst("\\.md$", "");
        String commandName = namespace != null
                ? "/" + namespace + ":" + baseName
                : "/" + baseName;

        String description = extractCommandDescription(mdFile.toPath());
        if (description == null) {
            description = "";
        }

        return new SlashCommand(commandName, description, source);
    }

    /**
     * Extracts description from a command .md file's YAML frontmatter.
     */
    private static String extractCommandDescription(Path mdPath) {
        String yamlText = SkillFrontmatterParser.extractFrontmatter(mdPath);
        if (yamlText == null) {
            return null;
        }

        try {
            LoadSettings settings = LoadSettings.builder()
                    .setMaxAliasesForCollections(0)
                    .setCodePointLimit(8192)
                    .build();
            Load load = new Load(settings);
            Object parsed = load.loadFromString(yamlText);

            if (parsed instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> map = (Map<String, Object>) parsed;
                Object desc = map.get("description");
                return desc != null ? String.valueOf(desc).trim() : null;
            }
        } catch (Exception e) {
            LOG.debug("Failed to parse command frontmatter: " + mdPath);
        }
        return null;
    }

    /**
     * Resolves user home from platform helper.
     */
    private static String resolveUserHome() {
        String home = PlatformUtils.getHomeDirectory();
        return home != null ? home : "";
    }

    /**
     * Normalizes a path string for consistent cross-platform comparison.
     */
    private static String normalizePath(String path) {
        if (path == null || path.isEmpty()) {
            return path;
        }
        try {
            return Paths.get(path).toAbsolutePath().normalize().toString();
        } catch (Exception e) {
            return path;
        }
    }

    private static Path toNormalizedPath(String path) {
        if (path == null || path.isEmpty()) {
            return null;
        }
        try {
            return Paths.get(path).toAbsolutePath().normalize();
        } catch (Exception e) {
            return null;
        }
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

    private static Path resolveManagedSkillsDirectory(Path managedPath) {
        Path candidate = managedPath.resolve(".claude").resolve("skills");
        if (Files.isDirectory(candidate)) {
            return candidate;
        }
        Path directSkills = managedPath.resolve("skills");
        if (Files.isDirectory(directSkills)) {
            return directSkills;
        }
        if (Files.isDirectory(managedPath) && managedPath.getFileName() != null
                && "skills".equals(managedPath.getFileName().toString())) {
            return managedPath;
        }
        return null;
    }

    private static boolean isManagedPathSafe(Path managedPath) {
        if (managedPath == null || !managedPath.isAbsolute()) {
            return false;
        }
        try {
            // Use toRealPath() to resolve ALL symlinks atomically, preventing TOCTOU races
            Path realPath = managedPath.toRealPath();
            if (!Files.isDirectory(realPath)) {
                return false;
            }
            return realPath.getNameCount() > 1;
        } catch (IOException e) {
            // Path does not exist or cannot be resolved — reject
            LOG.debug("Cannot resolve real path for managed directory safety check: " + managedPath);
            return false;
        }
    }

    private static Path getPolicySettingsPath() {
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

    private static List<JsonObject> getMergedClaudeSettings(String cwd, String userHome) {
        List<JsonObject> settings = new ArrayList<>();

        if (userHome != null && !userHome.isEmpty()) {
            try {
                Path userSettings = Paths.get(userHome, ".claude", "settings.json");
                JsonObject user = readJsonObject(userSettings);
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
                JsonObject project = readJsonObject(projectSettings);
                if (project != null) {
                    settings.add(project);
                }

                Path localSettings = cwdPath.resolve(".claude").resolve("settings.local.json");
                JsonObject local = readJsonObject(localSettings);
                if (local != null) {
                    settings.add(local);
                }
            } catch (Exception e) {
                LOG.debug("Invalid cwd for settings merge: " + cwd);
            }
        }

        return settings;
    }

    private static Map<String, Boolean> getEnabledPlugins(String cwd, String userHome) {
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

    private static Path resolvePluginSubPath(Path pluginDir, String declaredPath) {
        try {
            Path path = Paths.get(declaredPath);
            if (path.isAbsolute()) {
                LOG.warn("Rejecting absolute plugin path: " + declaredPath);
                return null;
            }
            return pluginDir.resolve(path).normalize();
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isPluginPathSafe(Path subPath, Path pluginDir) {
        if (subPath == null || pluginDir == null) {
            return false;
        }

        try {
            // Use toRealPath() to resolve ALL symlinks atomically, preventing TOCTOU and symlink bypass
            Path realSubPath = subPath.toRealPath();
            Path realPluginDir = pluginDir.toRealPath();

            if (!realSubPath.startsWith(realPluginDir)) {
                return false;
            }

            return !realSubPath.equals(realPluginDir);
        } catch (IOException e) {
            // Path does not exist or cannot be resolved — reject
            LOG.debug("Cannot resolve real path for plugin path safety check: " + subPath);
            return false;
        }
    }

    private static Path resolvePluginManifestPath(Path pluginDir) {
        if (pluginDir == null) {
            return null;
        }
        Path claudePluginManifest = pluginDir.resolve(".claude-plugin").resolve("plugin.json");
        if (Files.isRegularFile(claudePluginManifest)) {
            return claudePluginManifest;
        }
        Path rootManifest = pluginDir.resolve("plugin.json");
        if (Files.isRegularFile(rootManifest)) {
            return rootManifest;
        }
        return null;
    }

    /**
     * Resolves a plugin manifest path from the marketplace directory as fallback.
     */
    private static Path resolveMarketplaceManifestPath(
            String pluginName,
            String marketplaceId,
            Map<String, String> knownMarketplaces
    ) {
        if (marketplaceId == null || knownMarketplaces == null) {
            return null;
        }

        // Defense-in-depth: reject plugin names that could traverse out of the plugins directory
        if (pluginName == null || pluginName.contains("..")) {
            return null;
        }

        String installLocation = knownMarketplaces.get(marketplaceId);
        if (installLocation == null || installLocation.isEmpty()) {
            return null;
        }

        try {
            Path marketplaceDir = Paths.get(installLocation).toAbsolutePath().normalize();
            Path pluginsDir = marketplaceDir.resolve("plugins");
            Path pluginEntry = pluginsDir.resolve(pluginName).toAbsolutePath().normalize();
            // Verify resolved path stays within the plugins directory
            if (!pluginEntry.startsWith(pluginsDir)) {
                LOG.warn("Plugin path escaped marketplace plugins dir: " + pluginEntry);
                return null;
            }
            return resolvePluginManifestPath(pluginEntry);
        } catch (Exception e) {
            LOG.debug("Failed to resolve marketplace manifest for plugin: " + pluginName);
            return null;
        }
    }

    /**
     * Reads known_marketplaces.json and returns marketplaceId to installLocation mapping.
     */
    private static Map<String, String> readKnownMarketplaces(String userHome) {
        Map<String, String> result = new HashMap<>();
        if (userHome == null || userHome.isEmpty()) {
            return result;
        }

        Path knownPath;
        try {
            knownPath = Paths.get(userHome, ".claude", "plugins", "known_marketplaces.json");
        } catch (Exception e) {
            return result;
        }

        JsonObject root = readJsonObject(knownPath);
        if (root == null) {
            return result;
        }

        for (String marketplaceId : root.keySet()) {
            JsonElement entry = root.get(marketplaceId);
            if (entry == null || !entry.isJsonObject()) {
                continue;
            }
            JsonElement locationElement = entry.getAsJsonObject().get("installLocation");
            if (locationElement != null && locationElement.isJsonPrimitive()) {
                String location = locationElement.getAsString();
                if (location != null && !location.trim().isEmpty()) {
                    result.put(marketplaceId, location.trim());
                }
            }
        }

        return result;
    }

    private static Map<String, InstalledPlugin> getInstalledPlugins(Path pluginsBase) {
        Map<String, InstalledPlugin> result = new HashMap<>();
        if (pluginsBase == null) {
            return result;
        }

        Path installedPluginsPath = pluginsBase.resolve("installed_plugins.json");
        JsonObject root = readJsonObject(installedPluginsPath);
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
        Path installDir = toNormalizedPath(plugin.installPath());
        return installDir != null && Files.isDirectory(installDir);
    }

    private static JsonObject readJsonObject(Path path) {
        if (path == null || !Files.isRegularFile(path)) {
            return null;
        }

        try {
            long size = Files.size(path);
            if (size > MAX_JSON_FILE_SIZE) {
                LOG.warn("JSON file too large, skipping: " + path + " (" + size + " bytes)");
                return null;
            }
        } catch (IOException e) {
            return null;
        }

        try (var reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            JsonElement parsed = JsonParser.parseReader(reader);
            if (parsed != null && parsed.isJsonObject()) {
                return parsed.getAsJsonObject();
            }
        } catch (Exception e) {
            LOG.debug("Failed to read JSON: " + path);
        }

        return null;
    }

    @SafeVarargs
    static List<SlashCommand> mergeCommandsInOrder(List<SlashCommand>... commandSources) {
        Map<String, SlashCommand> merged = new LinkedHashMap<>();
        for (List<SlashCommand> source : commandSources) {
            if (source == null) {
                continue;
            }
            for (SlashCommand cmd : source) {
                merged.put(cmd.name(), cmd);
            }
        }
        return new ArrayList<>(merged.values());
    }
}

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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
     * Represents plugin-contributed skill directory info.
     */
    public record PluginSkillPath(String pluginName, String path) {
    }

    /**
     * Installed plugin descriptor from installed_plugins.json.
     */
    private record InstalledPlugin(String pluginId, String installPath, String version) {
    }

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
     * Finds the repository root by walking up from cwd looking for a .git directory.
     *
     * @param cwd the current working directory
     * @return the repo root path, or null if not in a git repository
     */
    public static String findRepoRoot(String cwd) {
        if (cwd == null || cwd.isEmpty()) {
            return null;
        }
        Path current;
        try {
            current = Paths.get(cwd).toAbsolutePath().normalize();
        } catch (Exception e) {
            LOG.debug("Invalid cwd for repo root detection: " + cwd);
            return null;
        }
        Path root = current.getRoot();

        while (current != null && !current.equals(root)) {
            if (Files.isDirectory(current.resolve(".git"))) {
                return current.toString();
            }
            current = current.getParent();
        }
        return null;
    }

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
        Path fsRoot = current.getRoot();
        Path homePath = null;
        if (userHome != null && !userHome.isEmpty()) {
            try {
                homePath = Paths.get(userHome).toAbsolutePath().normalize();
            } catch (Exception e) {
                LOG.debug("Invalid user home path for skill scanning: " + userHome);
            }
        }

        while (current != null && !current.equals(fsRoot)) {
            Path candidate = current.resolve(".claude").resolve(type);
            String normalizedCandidate = normalizePath(candidate.toString());
            if (Files.isDirectory(candidate) && seen.add(normalizedCandidate)) {
                dirs.add(new SkillScanDir(candidate.toString(), "project"));
            }

            if (homePath != null && current.equals(homePath)) {
                break;
            }

            current = current.getParent();
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
            LOG.info("Managed directory from env: " + normalized);
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
                    LOG.info("Managed directory from policy file: " + normalized);
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
            LOG.info("Managed skills directory not found under: " + managedPath);
            return List.of();
        }

        return scanSkillsAsCommands(skillsDir.toString(), "managed", null, toNormalizedPath(currentFilePath));
    }

    /**
     * Gets plugin skill paths from enabled Claude Code plugins.
     *
     * @param cwd current working directory
     * @return plugin skill paths
     */
    public static List<PluginSkillPath> getPluginSkillPaths(String cwd) {
        return getPluginSkillPaths(cwd, resolveUserHome());
    }

    /**
     * Gets plugin skill paths from enabled Claude Code plugins with explicit home path.
     */
    static List<PluginSkillPath> getPluginSkillPaths(String cwd, String userHome) {
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

        List<PluginSkillPath> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        for (Map.Entry<String, Boolean> entry : enabledPlugins.entrySet()) {
            if (!Boolean.TRUE.equals(entry.getValue())) {
                continue;
            }

            String pluginId = entry.getKey();
            String pluginName = pluginId.split("@", 2)[0];
            InstalledPlugin installed = installedPlugins.get(pluginId);
            Path pluginDir = installed != null && installed.installPath() != null
                    ? toNormalizedPath(installed.installPath())
                    : null;
            if (pluginDir == null) {
                pluginDir = pluginsBase.resolve(pluginId).toAbsolutePath().normalize();
            }
            Path manifestPath = resolvePluginManifestPath(pluginDir);

            if (manifestPath == null || !Files.isRegularFile(manifestPath)) {
                LOG.info("Plugin manifest not found, skip: " + manifestPath);
                continue;
            }

            JsonObject manifest = readJsonObject(manifestPath);
            if (manifest == null) {
                LOG.warn("Failed to parse plugin manifest: " + manifestPath);
                continue;
            }

            List<String> declaredPaths = new ArrayList<>();
            JsonElement skillsPath = manifest.get("skillsPath");
            if (skillsPath != null && skillsPath.isJsonPrimitive()) {
                declaredPaths.add(skillsPath.getAsString());
            }
            JsonElement skillsPaths = manifest.get("skillsPaths");
            if (skillsPaths != null && skillsPaths.isJsonArray()) {
                for (JsonElement item : skillsPaths.getAsJsonArray()) {
                    if (item != null && item.isJsonPrimitive()) {
                        declaredPaths.add(item.getAsString());
                    }
                }
            }
            // Claude plugin packages commonly use implicit ./skills without explicit skillsPath.
            if (declaredPaths.isEmpty()) {
                declaredPaths.add("skills");
            }

            for (String declaredPath : declaredPaths) {
                if (declaredPath == null || declaredPath.trim().isEmpty()) {
                    continue;
                }

                Path resolved = resolvePluginSkillsPath(pluginDir, declaredPath.trim());
                if (resolved == null || !isPluginSkillPathSafe(resolved, pluginDir)) {
                    LOG.warn("Rejected plugin skill path: " + declaredPath + " from plugin " + pluginId);
                    continue;
                }
                if (!Files.isDirectory(resolved)) {
                    LOG.info("Plugin skill directory does not exist: " + resolved);
                    continue;
                }

                String key = pluginName + "::" + normalizePath(resolved.toString());
                if (seen.add(key)) {
                    result.add(new PluginSkillPath(pluginName, resolved.toString()));
                    LOG.info("Accepted plugin skill path: " + resolved + " (plugin=" + pluginId + ")");
                }
            }
        }

        LOG.info("Discovered plugin skill paths: " + result.size());
        return result;
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
            pluginSkillCommands = scanPluginSkills(cwd, currentFilePath, userHome);
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
     * Scans enabled plugins and returns plugin-prefixed slash commands.
     */
    private static List<SlashCommand> scanPluginSkills(String cwd, String currentFilePath, String userHome) {
        List<PluginSkillPath> pluginPaths = getPluginSkillPaths(cwd, userHome);
        if (pluginPaths.isEmpty()) {
            return List.of();
        }

        Map<String, SlashCommand> merged = new LinkedHashMap<>();
        Path currentFile = toNormalizedPath(currentFilePath);
        for (PluginSkillPath pluginPath : pluginPaths) {
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
     * Scans a commands directory for .md files and converts them to slash commands.
     * Supports namespaced commands via subdirectories (e.g. opsx/explore.md → /opsx:explore).
     */
    private static List<SlashCommand> scanCommandsAsCommands(String dirPath, String source) {
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
            if (entry.getName().startsWith(".")) {
                continue;
            }

            if (entry.isFile() && entry.getName().endsWith(".md")) {
                // Top-level command: commit.md → /commit
                SlashCommand cmd = parseCommandFile(entry, null, source);
                if (cmd != null) {
                    commands.add(cmd);
                }
            } else if (entry.isDirectory()) {
                // Namespaced commands: opsx/explore.md → /opsx:explore
                String namespace = entry.getName();
                File[] subEntries = entry.listFiles();
                if (subEntries == null) {
                    continue;
                }

                for (File subEntry : subEntries) {
                    if (subEntry.isFile() && subEntry.getName().endsWith(".md")
                                && !subEntry.getName().startsWith(".")) {
                        SlashCommand cmd = parseCommandFile(subEntry, namespace, source);
                        if (cmd != null) {
                            commands.add(cmd);
                        }
                    }
                }
            }
        }
        return commands;
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
                    .setMaxAliasesForCollections(10)
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
        if (!Files.isDirectory(managedPath)) {
            return false;
        }
        if (managedPath.getNameCount() <= 1) {
            return false;
        }
        return !Files.isSymbolicLink(managedPath);
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

    private static Path resolvePluginSkillsPath(Path pluginDir, String declaredPath) {
        try {
            Path path = Paths.get(declaredPath);
            if (path.isAbsolute()) {
                return path.normalize();
            }
            return pluginDir.resolve(path).normalize();
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isPluginSkillPathSafe(Path skillPath, Path pluginDir) {
        if (skillPath == null || pluginDir == null) {
            return false;
        }

        Path normalizedSkillPath = skillPath.toAbsolutePath().normalize();
        Path normalizedPluginDir = pluginDir.toAbsolutePath().normalize();

        if (!normalizedSkillPath.startsWith(normalizedPluginDir)) {
            return false;
        }

        if (normalizedSkillPath.equals(normalizedPluginDir)) {
            return false;
        }

        return !Files.isSymbolicLink(normalizedSkillPath);
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

package com.github.claudecodegui.skill;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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

    // Claude built-in commands (GUI-relevant only; CLI-only and frontend-local ones are excluded)
    // Includes commands that work via SDK or are handled by frontend locally
    // 'local-jsx' commands (TUI UI) that have GUI equivalents are included
    // Bundled skills from CLI that are userInvocable and work in GUI environment
    public static final List<SlashCommand> CLAUDE_BUILTIN = List.of(
            new SlashCommand("/compact", "Summarize conversation to free context", "builtin"),
            new SlashCommand("/context", "Visualize current context usage as a colored grid", "builtin"),
            new SlashCommand("/init", "Initialize a new CLAUDE.md file with codebase documentation", "builtin"),
            new SlashCommand("/plan", "Switch to plan mode", "builtin"),
            new SlashCommand("/resume", "Resume a previous conversation", "builtin"),
            new SlashCommand("/review", "Review a pull request", "builtin"),
            // Bundled skills (userInvocable, no ANT-only restriction)
            new SlashCommand("/batch", "Execute large-scale changes in parallel across isolated worktrees", "bundled"),
            new SlashCommand("/claude-api", "Build apps with the Claude API or Anthropic SDK", "bundled"),
            new SlashCommand("/debug", "Enable debug logging and diagnose session issues", "bundled"),
            new SlashCommand("/loop", "Run a prompt or command on a recurring interval", "bundled"),
            new SlashCommand("/simplify", "Review changed code for reuse, quality, and efficiency", "bundled"),
            new SlashCommand("/update-config", "Configure settings.json (hooks, permissions, env vars)", "bundled")
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
     */
    public static List<SkillScanDir> getSkillScanDirs(String cwd, String type) {
        return getSkillScanDirs(cwd, type, resolveUserHome());
    }

    /**
     * Gets the list of directories to scan for Claude skills or commands with explicit home path.
     */
    static List<SkillScanDir> getSkillScanDirs(String cwd, String type, String userHome) {
        return AdditionalDirectoryResolver.getSkillScanDirs(cwd, type, userHome);
    }

    public static List<SkillScanDir> getCommandScanDirs(String cwd) {
        return getSkillScanDirs(cwd, "commands");
    }

    public static List<SkillScanDir> getSkillsScanDirs(String cwd) {
        return getSkillScanDirs(cwd, "skills");
    }

    /**
     * Gets configured additional directories for Claude scanning.
     * Reads additionalDirectoriesForClaudeMd from settings.
     */
    public static List<String> getAdditionalDirectories(String cwd) {
        return getAdditionalDirectories(cwd, resolveUserHome());
    }

    /**
     * Gets configured additional directories for Claude scanning with explicit home path.
     */
    static List<String> getAdditionalDirectories(String cwd, String userHome) {
        return AdditionalDirectoryResolver.getAdditionalDirectories(cwd, userHome);
    }

    /**
     * Returns managed directory from env or policy settings file.
     */
    public static String getManagedDirectory() {
        return getManagedDirectory(System.getenv(), AdditionalDirectoryResolver.getPolicySettingsPath());
    }

    /**
     * Returns managed directory from env or policy settings file.
     */
    static String getManagedDirectory(Map<String, String> env, Path policyPath) {
        return AdditionalDirectoryResolver.getManagedDirectory(env, policyPath);
    }

    /**
     * Scans managed skills directory.
     */
    public static List<SlashCommand> scanManagedSkills(String managedDir, String currentFilePath) {
        return ManagedSkillScanner.scanManagedSkills(managedDir, currentFilePath);
    }

    /**
     * Gets plugin paths (skills and commands) from enabled Claude Code plugins.
     */
    public static List<PluginPath> getPluginPaths(String cwd) {
        return getPluginPaths(cwd, resolveUserHome());
    }

    /**
     * Gets plugin paths from enabled Claude Code plugins with explicit home path.
     */
    static List<PluginPath> getPluginPaths(String cwd, String userHome) {
        return PluginCommandScanner.getPluginPaths(cwd, userHome);
    }

    /**
     * Matches current file against conditional path patterns.
     */
    public static boolean matchesPathPatterns(Path currentFile, List<String> patterns) {
        return SlashCommandPathPolicy.matchesPathPatterns(currentFile, patterns);
    }

    /**
     * Gets the merged slash command list for a given provider and working directory.
     */
    public static List<SlashCommand> getCommands(String provider, String cwd) {
        return getCommands(provider, cwd, null);
    }

    /**
     * Gets the merged slash command list for a given provider and working directory.
     */
    public static List<SlashCommand> getCommands(String provider, String cwd, String currentFilePath) {
        boolean isCodex = "codex".equalsIgnoreCase(provider);

        List<SlashCommand> builtins = isCodex ? CODEX_BUILTIN : CLAUDE_BUILTIN;
        String userHome = resolveUserHome();
        Path currentFile = SlashCommandPathPolicy.toNormalizedPath(currentFilePath);

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
            if (userHome.isEmpty()) {
                globalCmdCommands = List.of();
            } else {
                globalCmdCommands = PromptCommandScanner.scanPromptsAsCommands(
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

            managedSkillCommands = ManagedSkillScanner.scanManagedSkills(getManagedDirectory(), currentFilePath);
            List<PluginPath> allPluginPaths = PluginCommandScanner.getPluginPaths(cwd, userHome);
            pluginSkillCommands = PluginCommandScanner.scanPluginSkills(allPluginPaths, currentFilePath);
            pluginCmdCommands = PluginCommandScanner.scanPluginCommands(allPluginPaths);
        }

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
     * Serializes a command list to JSON array format.
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

                if (skill.has("enabled") && !skill.get("enabled").getAsBoolean()) {
                    continue;
                }
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
     * Scans a skills directory for valid skill subdirectories and converts them to slash commands.
     * Skips plain files and hidden directories.
     * <p>
     * Package-private: intentionally shared with {@link ManagedSkillScanner} and
     * {@link PluginCommandScanner} which delegate skill scanning back to this central method.
     */
    static List<SlashCommand> scanSkillsAsCommands(
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
            if (!entry.isDirectory() || entry.getName().startsWith(".")) {
                continue;
            }

            SkillFrontmatterParser.SkillMetadata metadata =
                    SkillFrontmatterParser.parse(entry.toPath());
            if (metadata == null) {
                LOG.debug("Skipping skill directory with invalid metadata: " + entry.getName());
                continue;
            }

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
     * <p>
     * Package-private: intentionally shared with {@link PluginCommandScanner}
     * which delegates command scanning back to this central method.
     */
    static List<SlashCommand> scanCommandsAsCommands(String dirPath, String source) {
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

    // Max recursion depth for command directory scanning to prevent runaway traversal.
    private static final int MAX_COMMAND_SCAN_DEPTH = 10;

    /**
     * Recursively scans a directory for command .md files.
     */
    private static void scanCommandsRecursive(
            File dir,
            Path baseDir,
            String source,
            List<SlashCommand> commands,
            int depth
    ) {
        if (depth > MAX_COMMAND_SCAN_DEPTH) {
            LOG.warn("Max command scan depth exceeded, skipping: " + dir);
            return;
        }
        File[] entries = dir.listFiles();
        if (entries == null) {
            return;
        }

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
     * Derives the colon-separated namespace from a command file's relative path.
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
     * Parses a single command .md file to extract name and description from frontmatter.
     */
    private static SlashCommand parseCommandFile(File mdFile, String namespace, String source) {
        String baseName = mdFile.getName().replaceFirst("\\.md$", "");
        String commandName = namespace != null
                ? "/" + namespace + ":" + baseName
                : "/" + baseName;

        String description = SlashCommandJsonReader.extractCommandDescription(mdFile.toPath());
        if (description == null) {
            description = "";
        }

        return new SlashCommand(commandName, description, source);
    }

    private static String resolveUserHome() {
        String home = PlatformUtils.getHomeDirectory();
        return home != null ? home : "";
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

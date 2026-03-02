package com.github.claudecodegui.skill;

import com.github.claudecodegui.CodexSkillService;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import org.snakeyaml.engine.v2.api.Load;
import org.snakeyaml.engine.v2.api.LoadSettings;

import java.io.File;
import java.nio.file.Path;
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
     * A slash command with name (including / prefix) and description.
     */
    public record SlashCommand(String name, String description) {
    }

    // Claude built-in commands (GUI-relevant only; CLI-only and frontend-local ones are excluded)
    public static final List<SlashCommand> CLAUDE_BUILTIN = List.of(
            new SlashCommand("/compact", "Toggle compact mode"),
            new SlashCommand("/init", "Initialize a new project"),
            new SlashCommand("/review", "Review changes before applying")
    );

    // Codex built-in commands (GUI-relevant only; CLI-only ones like /status, /model, /quit are excluded)
    public static final List<SlashCommand> CODEX_BUILTIN = List.of(
            new SlashCommand("/compact", "Summarize conversation to free tokens"),
            new SlashCommand("/diff", "Show pending changes diff including untracked files"),
            new SlashCommand("/init", "Generate an AGENTS.md scaffold"),
            new SlashCommand("/plan", "Switch to plan mode"),
            new SlashCommand("/review", "Review working tree changes")
    );

    /**
     * Scans a skills directory for valid skill subdirectories and converts them to slash commands.
     * Skips plain files and hidden directories.
     */
    private static List<SlashCommand> scanSkillsAsCommands(String dirPath) {
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

            commands.add(new SlashCommand("/" + metadata.name(), metadata.description()));
        }
        return commands;
    }

    /**
     * Scans a commands directory for .md files and converts them to slash commands.
     * Supports namespaced commands via subdirectories (e.g. opsx/explore.md → /opsx:explore).
     */
    private static List<SlashCommand> scanCommandsAsCommands(String dirPath) {
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
                SlashCommand cmd = parseCommandFile(entry, null);
                if (cmd != null) {
                    commands.add(cmd);
                }
            } else if (entry.isDirectory()) {
                // Namespaced commands: opsx/explore.md → /opsx:explore
                String namespace = entry.getName();
                File[] subEntries = entry.listFiles();
                if (subEntries == null) continue;

                for (File subEntry : subEntries) {
                    if (subEntry.isFile() && subEntry.getName().endsWith(".md")
                                && !subEntry.getName().startsWith(".")) {
                        SlashCommand cmd = parseCommandFile(subEntry, namespace);
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
     * All prompts are namespaced as /prompts:&lt;name&gt; per Codex convention.
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
                    description != null ? description : ""));
        }
        return commands;
    }

    /**
     * Parses a single command .md file to extract name and description from frontmatter.
     */
    private static SlashCommand parseCommandFile(File mdFile, String namespace) {
        String baseName = mdFile.getName().replaceFirst("\\.md$", "");
        String commandName = namespace != null
                                     ? "/" + namespace + ":" + baseName
                                     : "/" + baseName;

        // Try to extract description from YAML frontmatter
        String description = extractCommandDescription(mdFile.toPath());
        if (description == null) {
            description = "";
        }

        return new SlashCommand(commandName, description);
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
            LoadSettings settings = LoadSettings.builder().build();
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
        return null; // Ensure we always return a value if not found
    }

    /**
     * Gets the merged slash command list for a given provider and working directory.
     * Claude merge order: built-in → project commands → project skills → personal commands → personal skills.
     * Codex merge order: built-in → prompts.
     * Later entries override earlier ones with the same name (personal > project per Claude docs).
     *
     * @param provider "claude" or "codex"
     * @param cwd      current working directory (for local skills/commands lookup)
     * @return deduplicated list of slash commands
     */
    public static List<SlashCommand> getCommands(String provider, String cwd) {
        boolean isCodex = "codex".equalsIgnoreCase(provider);

        // Step 1: Select built-in commands by provider
        List<SlashCommand> builtins = isCodex ? CODEX_BUILTIN : CLAUDE_BUILTIN;

        String userHome = PlatformUtils.getHomeDirectory();

        List<SlashCommand> globalCmdCommands;
        List<SlashCommand> globalSkillCommands;
        List<SlashCommand> localCmdCommands = List.of();
        List<SlashCommand> localSkillCommands = List.of();

        if (isCodex) {
            // Codex slash commands come only from ~/.codex/prompts/ (namespaced as /prompts:<name>)
            // Codex skills (.agents/skills/) use $ prefix, not / — they are NOT slash commands
            globalCmdCommands = scanPromptsAsCommands(
                    userHome + File.separator + ".codex" + File.separator + "prompts");
            globalSkillCommands = List.of();
        } else {
            // Claude: ~/.claude/commands/ and ~/.claude/skills/
            String claudeDir = userHome + File.separator + ".claude";
            globalCmdCommands = scanCommandsAsCommands(
                    claudeDir + File.separator + "commands");
            globalSkillCommands = scanSkillsAsCommands(
                    claudeDir + File.separator + "skills");

            // Claude local: {cwd}/.claude/commands/ and skills/
            if (cwd != null && !cwd.isEmpty()) {
                String localClaudeDir = cwd + File.separator + ".claude";
                localCmdCommands = scanCommandsAsCommands(
                        localClaudeDir + File.separator + "commands");
                localSkillCommands = scanSkillsAsCommands(
                        localClaudeDir + File.separator + "skills");
            }
        }

        // Merge (preserves insertion order, later overrides earlier)
        // For Claude: built-in → project → personal (personal wins per docs)
        Map<String, SlashCommand> merged = new LinkedHashMap<>();
        for (SlashCommand cmd : builtins) {
            merged.put(cmd.name(), cmd);
        }
        for (SlashCommand cmd : localCmdCommands) {
            merged.put(cmd.name(), cmd);
        }
        for (SlashCommand cmd : localSkillCommands) {
            merged.put(cmd.name(), cmd);
        }
        for (SlashCommand cmd : globalCmdCommands) {
            merged.put(cmd.name(), cmd);
        }
        for (SlashCommand cmd : globalSkillCommands) {
            merged.put(cmd.name(), cmd);
        }

        // Step 6: Return merged results
        return new ArrayList<>(merged.values());
    }

    /**
     * Serializes a command list to JSON array format:
     * [{"name": "/help", "description": "..."}, ...]
     */
    public static String toJson(List<SlashCommand> commands) {
        JsonArray array = new JsonArray();
        for (SlashCommand cmd : commands) {
            JsonObject obj = new JsonObject();
            obj.addProperty("name", cmd.name());
            obj.addProperty("description", cmd.description());
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
            if (scopeSkills == null) continue;

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
                    merged.put("$" + name, new SlashCommand("$" + name, desc));
                }
            }
        }
        return new ArrayList<>(merged.values());
    }

}

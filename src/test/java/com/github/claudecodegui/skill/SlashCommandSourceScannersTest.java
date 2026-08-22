package com.github.claudecodegui.skill;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assume.assumeNoException;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SlashCommandSourceScannersTest {

    @Test
    public void managedSkillScannerReadsConditionalSkillsFromManagedDirectory() throws IOException {
        Path root = Files.createTempDirectory("slash-command-managed-scanner");
        Path managedDir = Files.createDirectories(root.resolve("managed"));
        Path skillDir = Files.createDirectories(managedDir.resolve(".claude").resolve("skills").resolve("review-java"));
        Files.writeString(
                skillDir.resolve("SKILL.md"),
                """
                ---
                name: review-java
                description: Review Java files
                paths:
                  - src/**/*.java
                ---

                Review Java files carefully.
                """
        );

        List<SlashCommandRegistry.SlashCommand> matchingCommands = ManagedSkillScanner.scanManagedSkills(
                managedDir.toString(),
                root.resolve("src").resolve("main").resolve("Main.java").toString()
        );
        List<SlashCommandRegistry.SlashCommand> nonMatchingCommands = ManagedSkillScanner.scanManagedSkills(
                managedDir.toString(),
                root.resolve("README.md").toString()
        );

        assertEquals(1, matchingCommands.size());
        assertEquals("/review-java", matchingCommands.get(0).name());
        assertEquals(0, nonMatchingCommands.size());
    }

    @Test
    public void promptCommandScannerNamespacesPromptMarkdownFiles() throws IOException {
        Path promptsDir = Files.createTempDirectory("slash-command-prompts");
        Files.writeString(
                promptsDir.resolve("fix.md"),
                """
                ---
                description: Repair the selected code
                ---

                Prompt body.
                """
        );

        List<SlashCommandRegistry.SlashCommand> commands = PromptCommandScanner.scanPromptsAsCommands(
                promptsDir.toString()
        );

        assertEquals(1, commands.size());
        assertEquals("/prompts:fix", commands.get(0).name());
        assertEquals("Repair the selected code", commands.get(0).description());
        assertEquals("codex-prompt", commands.get(0).source());
    }

    @Test
    public void pluginCommandScannerDiscoversSafePluginPathsAndPrefixesCommands() throws IOException {
        Path root = Files.createTempDirectory("slash-command-plugin-scanner");
        Path home = Files.createDirectories(root.resolve("home"));
        Path userClaudeDir = Files.createDirectories(home.resolve(".claude"));
        Path pluginsBase = Files.createDirectories(userClaudeDir.resolve("plugins"));
        Path installDir = Files.createDirectories(root.resolve("plugin-install"));
        Path skillsDir = Files.createDirectories(installDir.resolve("skills").resolve("reviewer"));
        Path commandsDir = Files.createDirectories(installDir.resolve("commands"));
        Files.createDirectories(installDir.resolve(".claude-plugin"));

        Files.writeString(
                skillsDir.resolve("SKILL.md"),
                """
                ---
                name: reviewer
                description: Review plugin content
                ---

                Plugin skill.
                """
        );
        Files.writeString(
                commandsDir.resolve("audit.md"),
                """
                ---
                description: Audit the current workspace
                ---

                Command body.
                """
        );
        Files.writeString(
                userClaudeDir.resolve("settings.json"),
                """
                {
                  "enabledPlugins": {
                    "demo@market": true
                  }
                }
                """
        );
        Files.writeString(
                pluginsBase.resolve("installed_plugins.json"),
                """
                {
                  "plugins": {
                    "demo@market": [
                      {
                        "version": "1.0.0",
                        "installPath": "%s"
                      }
                    ]
                  }
                }
                """.formatted(installDir.toString().replace("\\", "\\\\"))
        );
        Files.writeString(
                installDir.resolve(".claude-plugin").resolve("plugin.json"),
                """
                {
                  "skillsPath": "skills",
                  "commandsPath": "commands"
                }
                """
        );

        List<SlashCommandRegistry.PluginPath> pluginPaths = PluginCommandScanner.getPluginPaths(
                root.resolve("workspace").toString(),
                home.toString()
        );
        List<SlashCommandRegistry.SlashCommand> pluginSkillCommands = PluginCommandScanner.scanPluginSkills(
                pluginPaths,
                null
        );
        List<SlashCommandRegistry.SlashCommand> pluginCommands = PluginCommandScanner.scanPluginCommands(
                pluginPaths
        );

        assertEquals(2, pluginPaths.size());
        assertEquals(1, pluginSkillCommands.size());
        assertEquals("/demo:reviewer", pluginSkillCommands.get(0).name());
        assertEquals("plugin:demo", pluginSkillCommands.get(0).source());
        assertEquals(1, pluginCommands.size());
        assertEquals("/demo:audit", pluginCommands.get(0).name());
        assertEquals("plugin:demo", pluginCommands.get(0).source());
    }

    @Test
    public void codexSkillScannerDiscoversNestedSkillDefinitionFiles() throws IOException {
        Path root = Files.createTempDirectory("codex-skill-nested-scanner");
        Path skillDir = Files.createDirectories(
                root.resolve("review").resolve("utility").resolve("agent-packaging-skill")
        );
        Path hiddenSkillDir = Files.createDirectories(
                root.resolve(".internal").resolve("hidden-skill")
        );
        Files.writeString(
                skillDir.resolve("SKILL.md"),
                """
                ---
                name: agent-packaging-skill
                description: Package a Codex agent skill
                userInvocable: true
                ---

                Package skills.
                """
        );
        Files.writeString(
                hiddenSkillDir.resolve("SKILL.md"),
                """
                ---
                name: hidden-skill
                description: Hidden skill
                ---
                """
        );

        JsonObject skills = CodexSkillService.scanSkillsDirectory(root.toString(), "user");

        assertEquals(1, skills.size());
        JsonObject skill = skills.entrySet().iterator().next().getValue().getAsJsonObject();
        assertEquals("agent-packaging-skill", skill.get("name").getAsString());
        assertEquals("Package a Codex agent skill", skill.get("description").getAsString());
        assertTrue(skill.get("userInvocable").getAsBoolean());
        assertEquals(skillDir.toString(), Path.of(skill.get("path").getAsString()).toString());
    }

    @Test
    public void codexSkillScannerSkipsGeneratedAndExcessivelyDeepDirectories() throws IOException {
        Path root = Files.createTempDirectory("codex-skill-bounded-scanner");
        Path generatedSkill = Files.createDirectories(
                root.resolve("package").resolve("node_modules").resolve("dependency")
        );
        Path deepSkill = root;
        for (int depth = 0; depth < 10; depth++) {
            deepSkill = deepSkill.resolve("level-" + depth);
        }
        Files.createDirectories(deepSkill);
        Files.writeString(generatedSkill.resolve("SKILL.md"), validSkill("generated-skill"));
        Files.writeString(deepSkill.resolve("SKILL.md"), validSkill("deep-skill"));

        JsonObject skills = CodexSkillService.scanSkillsDirectory(root.toString(), "user");

        assertEquals(0, skills.size());
    }

    @Test
    public void codexSkillScannerTreatsSkillPackagesAsTraversalBoundaries() throws IOException {
        Path root = Files.createTempDirectory("codex-skill-package-boundary");
        Path largeSkill = Files.createDirectories(root.resolve("large-skill"));
        Path nestedSkill = Files.createDirectories(largeSkill.resolve("assets").resolve("nested-skill"));
        Path siblingSkill = Files.createDirectories(root.resolve("sibling-skill"));
        Files.writeString(largeSkill.resolve("SKILL.md"), validSkill("large-skill"));
        Files.writeString(nestedSkill.resolve("SKILL.md"), validSkill("nested-skill"));
        Files.writeString(siblingSkill.resolve("SKILL.md"), validSkill("sibling-skill"));

        JsonObject skills = CodexSkillService.scanSkillsDirectory(root.toString(), "user", 3);

        assertEquals(2, skills.size());
        assertTrue(hasSkillNamed(skills, "large-skill"));
        assertTrue(hasSkillNamed(skills, "sibling-skill"));
        assertFalse(hasSkillNamed(skills, "nested-skill"));
    }

    @Test
    public void codexSkillScannerStopsAtInvalidSkillPackage() throws IOException {
        Path root = Files.createTempDirectory("codex-invalid-skill-boundary");
        Path invalidSkill = Files.createDirectories(root.resolve("invalid-skill"));
        Path nestedSkill = Files.createDirectories(invalidSkill.resolve("resources").resolve("nested-skill"));
        Files.writeString(invalidSkill.resolve("SKILL.md"), "Invalid skill metadata");
        Files.writeString(nestedSkill.resolve("SKILL.md"), validSkill("nested-skill"));

        JsonObject skills = CodexSkillService.scanSkillsDirectory(root.toString(), "user");

        assertEquals(1, skills.size());
        JsonObject skill = skills.entrySet().iterator().next().getValue().getAsJsonObject();
        assertEquals("invalid-skill", skill.get("name").getAsString());
        assertEquals("invalid_frontmatter", skill.get("warning").getAsString());
        assertFalse(hasSkillNamed(skills, "nested-skill"));
    }

    @Test
    public void codexSkillScannerSupportsLowercaseDefinitionFile() throws IOException {
        Path root = Files.createTempDirectory("codex-lowercase-skill-definition");
        Path skillDir = Files.createDirectories(root.resolve("lowercase-skill"));
        Files.writeString(skillDir.resolve("skill.md"), validSkill("lowercase-skill"));

        JsonObject skills = CodexSkillService.scanSkillsDirectory(root.toString(), "user");

        assertEquals(1, skills.size());
        assertTrue(hasSkillNamed(skills, "lowercase-skill"));
    }

    @Test
    public void codexSkillScannerDoesNotFollowSymlinkedDefinitionFile() throws IOException {
        Path root = Files.createTempDirectory("codex-symlink-skill-definition");
        Path definition = root.resolve("definition.md");
        Path skillDir = Files.createDirectories(root.resolve("linked-skill"));
        Files.writeString(definition, validSkill("linked-skill"));
        try {
            Files.createSymbolicLink(skillDir.resolve("SKILL.md"), definition);
        } catch (IOException | UnsupportedOperationException | SecurityException e) {
            assumeNoException(e);
        }

        JsonObject skills = CodexSkillService.scanSkillsDirectory(root.toString(), "user");

        assertEquals(0, skills.size());
    }

    @Test
    public void codexSkillScannerStillEnforcesNodeLimitForCollectionDirectories() throws IOException {
        Path root = Files.createTempDirectory("codex-skill-node-limit");
        Path skillDir = Files.createDirectories(root.resolve("collection").resolve("nested").resolve("skill"));
        Files.writeString(skillDir.resolve("SKILL.md"), validSkill("limited-skill"));

        JsonObject skills = CodexSkillService.scanSkillsDirectory(root.toString(), "user", 3);

        assertEquals(0, skills.size());
    }

    @Test
    public void codexSkillTogglePathMustExistInsideConfiguredSkillDirectory() throws IOException {
        Path root = Files.createTempDirectory("codex-skill-toggle-path");
        Path allowedSkill = Files.createDirectories(
                root.resolve(".agents").resolve("skills").resolve("review"));
        Path allowedSkillFile = allowedSkill.resolve("SKILL.md");
        Files.writeString(allowedSkillFile, validSkill("review"));
        Path outsideSkill = Files.createDirectories(root.resolve("outside")).resolve("SKILL.md");
        Files.writeString(outsideSkill, validSkill("outside"));

        assertTrue(CodexSkillService.isToggleSkillPathAllowed(allowedSkillFile.toString(), root.toString()));
        assertFalse(CodexSkillService.isToggleSkillPathAllowed(outsideSkill.toString(), root.toString()));
        assertFalse(CodexSkillService.isToggleSkillPathAllowed(
                allowedSkill.resolve("missing").resolve("SKILL.md").toString(), root.toString()));
    }

    private boolean hasSkillNamed(JsonObject skills, String name) {
        return skills.entrySet().stream()
                .map(entry -> entry.getValue().getAsJsonObject())
                .anyMatch(skill -> name.equals(skill.get("name").getAsString()));
    }

    private String validSkill(String name) {
        return """
                ---
                name: %s
                description: Test skill
                userInvocable: true
                ---

                Test skill.
                """.formatted(name);
    }
}

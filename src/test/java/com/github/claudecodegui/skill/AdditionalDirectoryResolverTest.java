package com.github.claudecodegui.skill;

import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class AdditionalDirectoryResolverTest {

    @Test
    public void getSkillScanDirsWalksUpwardUntilHomeBoundary() throws IOException {
        Path root = Files.createTempDirectory("slash-command-scan-dirs");
        Path home = Files.createDirectories(root.resolve("home"));
        Path workspace = Files.createDirectories(home.resolve("workspace"));
        Path project = Files.createDirectories(workspace.resolve("project"));
        Path nested = Files.createDirectories(project.resolve("nested"));

        Files.createDirectories(home.resolve(".claude").resolve("commands"));
        Files.createDirectories(project.resolve(".claude").resolve("commands"));

        List<SlashCommandRegistry.SkillScanDir> dirs = AdditionalDirectoryResolver.getSkillScanDirs(
                nested.toString(),
                "commands",
                home.toString()
        );

        assertEquals(2, dirs.size());
        assertEquals(project.resolve(".claude").resolve("commands").toString(), dirs.get(0).path());
        assertEquals(home.resolve(".claude").resolve("commands").toString(), dirs.get(1).path());
    }

    @Test
    public void getAdditionalDirectoriesMergesUserProjectAndLocalSettings() throws IOException {
        Path root = Files.createTempDirectory("slash-command-additional-dirs");
        Path home = Files.createDirectories(root.resolve("home"));
        Path cwd = Files.createDirectories(root.resolve("workspace"));
        Path userOnly = Files.createDirectories(home.resolve("user-only"));
        Path shared = Files.createDirectories(root.resolve("shared"));
        Path projectOnly = Files.createDirectories(cwd.resolve("project-only"));
        Path localOnly = Files.createDirectories(cwd.resolve("local-only"));

        Path userClaude = Files.createDirectories(home.resolve(".claude"));
        Path projectClaude = Files.createDirectories(cwd.resolve(".claude"));

        Files.writeString(
                userClaude.resolve("settings.json"),
                """
                {
                  "additionalDirectoriesForClaudeMd": [
                    "%s",
                    "%s"
                  ]
                }
                """.formatted(toJsonPath(shared), toJsonPath(userOnly))
        );
        Files.writeString(
                projectClaude.resolve("settings.json"),
                """
                {
                  "additionalDirectoriesForClaudeMd": [
                    "%s",
                    "project-only"
                  ]
                }
                """.formatted(toJsonPath(shared))
        );
        Files.writeString(
                projectClaude.resolve("settings.local.json"),
                """
                {
                  "additionalDirectoriesForClaudeMd": "local-only"
                }
                """
        );

        List<String> directories = AdditionalDirectoryResolver.getAdditionalDirectories(
                cwd.toString(),
                home.toString()
        );

        assertEquals(List.of(
                shared.toString(),
                userOnly.toString(),
                projectOnly.toString(),
                localOnly.toString()
        ), directories);
    }

    @Test
    public void getManagedDirectoryPrefersEnvOverPolicySettings() throws IOException {
        Path root = Files.createTempDirectory("slash-command-managed-dir");
        Path envDir = Files.createDirectories(root.resolve("env-managed"));
        Path policyDir = Files.createDirectories(root.resolve("policy-managed"));
        Path policyFile = root.resolve("managed-settings.json");
        Files.writeString(
                policyFile,
                """
                {
                  "managedDirectory": "%s"
                }
                """.formatted(toJsonPath(policyDir))
        );

        Map<String, String> env = new HashMap<>();
        env.put("CLAUDE_CODE_MANAGED_DIR", envDir.toString());

        String managedDirectory = AdditionalDirectoryResolver.getManagedDirectory(env, policyFile);

        assertEquals(envDir.toString(), managedDirectory);
    }

    @Test
    public void getManagedDirectoryFallsToPolicyFileWhenEnvIsAbsent() throws IOException {
        Path root = Files.createTempDirectory("slash-command-managed-dir-policy");
        Path policyDir = Files.createDirectories(root.resolve("policy-managed"));
        Path policyFile = root.resolve("managed-settings.json");
        Files.writeString(
                policyFile,
                """
                {
                  "managedDirectory": "%s"
                }
                """.formatted(toJsonPath(policyDir))
        );

        Map<String, String> emptyEnv = new HashMap<>();

        String managedDirectory = AdditionalDirectoryResolver.getManagedDirectory(emptyEnv, policyFile);

        assertEquals(policyDir.toString(), managedDirectory);
    }

    @Test
    public void getManagedDirectoryReturnsNullWhenBothEnvAndPolicyAreAbsent() throws IOException {
        Path root = Files.createTempDirectory("slash-command-managed-dir-none");
        Path missingPolicy = root.resolve("nonexistent-settings.json");

        Map<String, String> emptyEnv = new HashMap<>();

        String managedDirectory = AdditionalDirectoryResolver.getManagedDirectory(emptyEnv, missingPolicy);

        assertNull(managedDirectory);
    }

    @Test
    public void getEnabledPluginsMergesSettingScopesWithLastWriterWins() throws IOException {
        Path root = Files.createTempDirectory("slash-command-enabled-plugins");
        Path home = Files.createDirectories(root.resolve("home"));
        Path cwd = Files.createDirectories(root.resolve("workspace"));
        Path userClaude = Files.createDirectories(home.resolve(".claude"));
        Path projectClaude = Files.createDirectories(cwd.resolve(".claude"));

        Files.writeString(
                userClaude.resolve("settings.json"),
                """
                {
                  "enabledPlugins": {
                    "demo@market": true,
                    "disabled@market": false
                  }
                }
                """
        );
        Files.writeString(
                projectClaude.resolve("settings.local.json"),
                """
                {
                  "enabledPlugins": {
                    "disabled@market": true
                  }
                }
                """
        );

        Map<String, Boolean> enabledPlugins = AdditionalDirectoryResolver.getEnabledPlugins(
                cwd.toString(),
                home.toString()
        );

        assertEquals(2, enabledPlugins.size());
        assertEquals(Boolean.TRUE, enabledPlugins.get("demo@market"));
        assertEquals(Boolean.TRUE, enabledPlugins.get("disabled@market"));
    }

    private String toJsonPath(Path path) {
        return path.toString().replace("\\", "\\\\");
    }
}

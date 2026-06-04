package com.github.claudecodegui.cli.common;

import com.github.claudecodegui.settings.ConfigPathManager;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CliSettingsIsolationTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void readClaudeEnvDoesNotFallBackToSdkClaudeSettings() throws Exception {
        Path tempHome = Files.createTempDirectory("cli-settings-isolation");
        useTemporaryHomeDirectory(tempHome);
        Path claudeDir = tempHome.resolve(".claude");
        Files.createDirectories(claudeDir);
        Files.writeString(claudeDir.resolve("settings.json"),
                "{\"env\":{\"ANTHROPIC_MODEL\":\"sdk-model\"}}",
                StandardCharsets.UTF_8);

        JsonObject env = CliSettings.readClaudeEnv();

        assertFalse(env.has("ANTHROPIC_MODEL"));
    }

    @Test
    public void readClaudeEnvUsesCliOnlySettingsWhenPresent() throws Exception {
        Path tempHome = Files.createTempDirectory("cli-settings-present");
        useTemporaryHomeDirectory(tempHome);
        Path cliSettingsPath = new ConfigPathManager().getCliSettingsFilePath();
        Files.createDirectories(cliSettingsPath.getParent());
        Files.writeString(cliSettingsPath,
                "{\"claudeEnv\":{\"ANTHROPIC_MODEL\":\"cli-model\"}}",
                StandardCharsets.UTF_8);

        JsonObject env = CliSettings.readClaudeEnv();

        assertEquals("cli-model", env.get("ANTHROPIC_MODEL").getAsString());
    }

    @Test
    public void readClaudeCliEnvironmentMergesSettingsJsonWithoutProtectedRuntimeKeys() throws Exception {
        Path tempHome = Files.createTempDirectory("cli-claude-env");
        useTemporaryHomeDirectory(tempHome);
        Path claudeDir = tempHome.resolve(".claude");
        Files.createDirectories(claudeDir);
        Files.writeString(claudeDir.resolve("settings.json"),
                """
                {
                  "env": {
                    "ANTHROPIC_BASE_URL": "https://claude-proxy.example.com",
                    "ANTHROPIC_AUTH_TOKEN": "sk-claude",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "provider-sonnet",
                    "HTTP_PROXY": "http://127.0.0.1:7890",
                    "CLAUDE_SESSION_ID": "must-not-leak"
                  },
                  "apiKeyHelper": "helper.cmd"
                }
                """,
                StandardCharsets.UTF_8);

        Map<String, String> env = CliSettings.readClaudeCliEnvironment();

        assertEquals("https://claude-proxy.example.com", env.get("ANTHROPIC_BASE_URL"));
        assertEquals("sk-claude", env.get("ANTHROPIC_AUTH_TOKEN"));
        assertEquals("provider-sonnet", env.get("ANTHROPIC_DEFAULT_SONNET_MODEL"));
        assertEquals("http://127.0.0.1:7890", env.get("HTTP_PROXY"));
        assertEquals("helper.cmd", env.get("ANTHROPIC_API_KEY_HELPER"));
        assertFalse(env.containsKey("CLAUDE_SESSION_ID"));
    }

    @Test
    public void readCodexCliEnvironmentReadsConfigTomlAndAuthJsonWithoutSandboxOverrides() throws Exception {
        Path tempHome = Files.createTempDirectory("cli-codex-env");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(codexDir.resolve("config.toml"),
                """
                model = "gpt-5.3-codex"
                model_provider = "eacase"
                sandbox_mode = "danger-full-access"

                [model_providers.eacase]
                base_url = "https://gpt.eacase.de5.net/v1"
                env_key = "EACASE_API_KEY"

                [env]
                EACASE_API_KEY = "sk-codex"
                HTTPS_PROXY = "http://127.0.0.1:7890"
                CODEX_SANDBOX_MODE = "must-not-leak"
                """,
                StandardCharsets.UTF_8);
        Files.writeString(codexDir.resolve("auth.json"),
                "{\"OPENAI_API_KEY\":\"sk-openai\"}",
                StandardCharsets.UTF_8);

        Map<String, String> env = CliSettings.readCodexCliEnvironment();

        assertEquals("gpt-5.3-codex", env.get("CODEX_MODEL"));
        assertEquals("https://gpt.eacase.de5.net/v1", env.get("OPENAI_BASE_URL"));
        assertEquals("sk-codex", env.get("EACASE_API_KEY"));
        assertEquals("sk-openai", env.get("OPENAI_API_KEY"));
        assertEquals("http://127.0.0.1:7890", env.get("HTTPS_PROXY"));
        assertFalse(env.containsKey("CODEX_SANDBOX_MODE"));
        assertFalse(env.containsKey("CODEX_SANDBOX"));
        assertTrue(env.containsKey("CODEX_MODEL"));
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
    }

    private String getCachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }
}

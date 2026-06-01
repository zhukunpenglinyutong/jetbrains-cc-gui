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

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

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

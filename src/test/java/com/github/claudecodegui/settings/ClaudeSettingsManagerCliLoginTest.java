package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
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
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for the CLI Login provider switch.
 *
 * Earlier versions of {@link ClaudeSettingsManager#applyCliLoginToClaudeSettings()}
 * destructively deleted ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the user's
 * ~/.claude/settings.json so the SDK would fall through to native OAuth. That
 * permanently wiped user-configured keys with no recovery path. The current
 * implementation must NOT touch settings.json at all — CLI login is identified
 * solely via ~/.codemoss/config.json.
 */
public class ClaudeSettingsManagerCliLoginTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void applyCliLoginMustPreserveExistingApiKey() throws Exception {
        Path tempHome = Files.createTempDirectory("claude-cli-login-preserve-key");
        useTemporaryHomeDirectory(tempHome);
        Path claudeDir = tempHome.resolve(".claude");
        Files.createDirectories(claudeDir);
        Path settingsPath = claudeDir.resolve("settings.json");

        String original = "{\"env\":{"
                + "\"ANTHROPIC_API_KEY\":\"sk-ant-user-key\","
                + "\"ANTHROPIC_AUTH_TOKEN\":\"sk-ant-user-token\","
                + "\"ANTHROPIC_BASE_URL\":\"https://api.anthropic.com\""
                + "}}";
        Files.writeString(settingsPath, original, StandardCharsets.UTF_8);

        ClaudeSettingsManager manager = newManager();
        manager.applyCliLoginToClaudeSettings();

        // settings.json must remain byte-for-byte intact
        JsonObject after = JsonParser.parseString(
                Files.readString(settingsPath, StandardCharsets.UTF_8)
        ).getAsJsonObject();
        JsonObject env = after.getAsJsonObject("env");

        assertEquals("sk-ant-user-key", env.get("ANTHROPIC_API_KEY").getAsString());
        assertEquals("sk-ant-user-token", env.get("ANTHROPIC_AUTH_TOKEN").getAsString());
        assertEquals("https://api.anthropic.com", env.get("ANTHROPIC_BASE_URL").getAsString());
        assertFalse("Plugin must not write the legacy CCGUI_CLI_LOGIN_AUTHORIZED flag",
                env.has("CCGUI_CLI_LOGIN_AUTHORIZED"));
    }

    @Test
    public void applyCliLoginIsIdempotentOnEmptySettings() throws Exception {
        Path tempHome = Files.createTempDirectory("claude-cli-login-empty");
        useTemporaryHomeDirectory(tempHome);
        Path claudeDir = tempHome.resolve(".claude");
        Files.createDirectories(claudeDir);

        ClaudeSettingsManager manager = newManager();
        manager.applyCliLoginToClaudeSettings();
        manager.applyCliLoginToClaudeSettings();
        // Must not crash and must not create unexpected mutations
        Path settingsPath = claudeDir.resolve("settings.json");
        if (Files.exists(settingsPath)) {
            JsonObject after = JsonParser.parseString(
                    Files.readString(settingsPath, StandardCharsets.UTF_8)
            ).getAsJsonObject();
            if (after.has("env") && !after.get("env").isJsonNull()) {
                assertFalse(after.getAsJsonObject("env").has("CCGUI_CLI_LOGIN_AUTHORIZED"));
            }
        }
    }

    @Test
    public void removeCliLoginCleansLegacyFlagFromOlderInstalls() throws Exception {
        Path tempHome = Files.createTempDirectory("claude-cli-login-cleanup");
        useTemporaryHomeDirectory(tempHome);
        Path claudeDir = tempHome.resolve(".claude");
        Files.createDirectories(claudeDir);
        Path settingsPath = claudeDir.resolve("settings.json");

        // Simulate residue from an older plugin version that wrote the flag
        String legacy = "{\"env\":{"
                + "\"CCGUI_CLI_LOGIN_AUTHORIZED\":\"1\","
                + "\"ANTHROPIC_API_KEY\":\"sk-ant-user-key\""
                + "}}";
        Files.writeString(settingsPath, legacy, StandardCharsets.UTF_8);

        ClaudeSettingsManager manager = newManager();
        manager.removeCliLoginFromClaudeSettings();

        JsonObject after = JsonParser.parseString(
                Files.readString(settingsPath, StandardCharsets.UTF_8)
        ).getAsJsonObject();
        JsonObject env = after.getAsJsonObject("env");

        assertFalse("Legacy flag must be cleaned up", env.has("CCGUI_CLI_LOGIN_AUTHORIZED"));
        assertTrue("User's API key must be preserved during cleanup", env.has("ANTHROPIC_API_KEY"));
        assertEquals("sk-ant-user-key", env.get("ANTHROPIC_API_KEY").getAsString());
    }

    private static ClaudeSettingsManager newManager() {
        Gson gson = new GsonBuilder().setPrettyPrinting().serializeNulls().create();
        return new ClaudeSettingsManager(gson, new ConfigPathManager());
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

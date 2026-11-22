package com.github.claudecodegui.provider;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for the Claude context window override.
 */
public class ClaudeContextWindowOverrideProviderTest {

    private static Path settingsFile(String json) throws Exception {
        Path settings = Files.createTempFile("claude-settings", ".json");
        Files.writeString(settings, json);
        return settings;
    }

    private static String overrideJson(int tokens) {
        return "{\"env\": {\"CLAUDE_CODE_MAX_CONTEXT_TOKENS\": \"" + tokens + "\"}}";
    }

    private static int readOverride(String json) throws Exception {
        Path settings = settingsFile(json);
        return ClaudeContextWindowOverrideProvider.createForTests(settings).readOverride(settings).orElse(-1);
    }

    private static Path projectWith(String fileName, String json) throws Exception {
        Path project = Files.createTempDirectory("claude-project");
        Path configDir = Files.createDirectories(project.resolve(".claude"));
        Files.writeString(configDir.resolve(fileName), json);
        return project;
    }

    @Test
    public void shouldReadOverrideFromClaudeSettingsEnv() throws Exception {
        assertEquals(512_000, readOverride("""
                {
                  "env": {
                    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "512000"
                  }
                }
                """));
    }

    @Test
    public void shouldIgnoreMissingOrInvalidOverride() throws Exception {
        assertEquals(-1, readOverride("{\"env\": {}}"));
        assertEquals(-1, readOverride("{}"));
        assertEquals(-1, readOverride("[]"));
        assertEquals(-1, readOverride("{\"env\": {\"CLAUDE_CODE_MAX_CONTEXT_TOKENS\": \"not-a-number\"}}"));
        assertEquals(-1, readOverride("{\"env\": {\"CLAUDE_CODE_MAX_CONTEXT_TOKENS\": \"0\"}}"));
    }

    @Test
    public void shouldParseOnlyPositiveIntegers() {
        assertEquals(512_000, ClaudeContextWindowOverrideProvider.parsePositiveInt(" 512000 ").orElse(-1));
        assertTrue(ClaudeContextWindowOverrideProvider.parsePositiveInt(null).isEmpty());
        assertTrue(ClaudeContextWindowOverrideProvider.parsePositiveInt("-1").isEmpty());
        assertTrue(ClaudeContextWindowOverrideProvider.parsePositiveInt("512k").isEmpty());
    }

    /**
     * The CLI loads settings with sessions started in a project, so project settings
     * beat user settings and the gitignored local file beats the shared project file.
     */
    @Test
    public void shouldPreferProjectSettingsOverUserSettings() throws Exception {
        ClaudeContextWindowOverrideProvider provider =
                ClaudeContextWindowOverrideProvider.createForTests(settingsFile(overrideJson(128_000)));
        Path project = projectWith("settings.json", overrideJson(256_000));
        Files.writeString(project.resolve(".claude").resolve("settings.local.json"), overrideJson(384_000));
        Path sharedOnly = projectWith("settings.json", overrideJson(256_000));

        assertEquals(128_000, provider.getOverride(null).orElse(-1));
        assertEquals(256_000, provider.getOverride(sharedOnly.toString()).orElse(-1));
        assertEquals(384_000, provider.getOverride(project.toString()).orElse(-1));
    }

    @Test
    public void shouldLetManagedSettingsWinOverEverything() throws Exception {
        ClaudeContextWindowOverrideProvider provider = ClaudeContextWindowOverrideProvider.createForTests(
                settingsFile(overrideJson(128_000)), settingsFile(overrideJson(64_000)));
        Path project = projectWith("settings.local.json", overrideJson(384_000));

        assertEquals(64_000, provider.getOverride(project.toString()).orElse(-1));
    }

    /**
     * Settings merge per key: the highest-precedence file that defines the key wins even
     * when its value is invalid, so a lower file's override does not leak through.
     */
    @Test
    public void shouldLetHighestPrecedenceDefinitionWinEvenWhenInvalid() throws Exception {
        ClaudeContextWindowOverrideProvider provider =
                ClaudeContextWindowOverrideProvider.createForTests(settingsFile(overrideJson(128_000)));
        Path project = projectWith("settings.local.json",
                "{\"env\": {\"CLAUDE_CODE_MAX_CONTEXT_TOKENS\": \"not-a-number\"}}");

        assertTrue(provider.getOverride(project.toString()).isEmpty());
    }

    @Test
    public void shouldReadDisableCompactWithCliTruthyValues() throws Exception {
        assertTrue(ClaudeContextWindowOverrideProvider.createForTests(
                settingsFile("{\"env\": {\"DISABLE_COMPACT\": \"1\"}}")).isCompactDisabled(null));
        assertTrue(ClaudeContextWindowOverrideProvider.createForTests(
                settingsFile("{\"env\": {\"DISABLE_COMPACT\": \" TRUE \"}}")).isCompactDisabled(null));
        assertFalse(ClaudeContextWindowOverrideProvider.createForTests(
                settingsFile("{\"env\": {\"DISABLE_COMPACT\": \"0\"}}")).isCompactDisabled(null));
    }

    @Test
    public void shouldExposeUserSettingsEnvAsCopy() throws Exception {
        ClaudeContextWindowOverrideProvider provider = ClaudeContextWindowOverrideProvider.createForTests(
                settingsFile("{\"env\": {\"ANTHROPIC_DEFAULT_SONNET_MODEL\": \"kimi-k3\"}}"));

        JsonObject env = provider.getUserSettingsEnv();
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "mutated");

        assertEquals("kimi-k3", provider.getUserSettingsEnv().get("ANTHROPIC_DEFAULT_SONNET_MODEL").getAsString());
        assertNull(ClaudeContextWindowOverrideProvider.createForTests(settingsFile("{}")).getUserSettingsEnv());
    }
}

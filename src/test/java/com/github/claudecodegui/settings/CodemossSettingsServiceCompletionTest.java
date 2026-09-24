package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.*;

/**
 * Unit tests for the codeCompletion section persistence in
 * {@link CodemossSettingsService}. Uses an isolated home (reflection on
 * PlatformUtils.cachedRealHomeDir) so the real ~/.codemoss/config.json is
 * never touched.
 */
public class CodemossSettingsServiceCompletionTest {

    private String originalHome;

    @After
    public void restoreHome() throws Exception {
        if (originalHome != null) {
            setHome(originalHome);
        }
    }

    @Test
    public void getDefaultsWhenSectionMissing() throws Exception {
        newIsolatedHome();
        CodemossSettingsService svc = new CodemossSettingsService();
        CodeCompletionSettings s = svc.getCodeCompletionSettings();
        assertFalse(s.isEnabled());
        assertEquals(CodeCompletionSettings.PRESET_DEEPSEEK, s.getPreset());
        assertEquals(CodeCompletionSettings.DEEPSEEK_PATH, s.getPath());
        assertEquals(CodeCompletionSettings.DEFAULT_BASE_URL, s.getBaseUrl());
        assertEquals(CodeCompletionSettings.DEFAULT_MODEL, s.getModel());
    }

    @Test
    public void roundTripsPersistedSettings() throws Exception {
        Path home = newIsolatedHome();
        CodemossSettingsService svc = new CodemossSettingsService();

        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setEnabled(true);
        s.setPreset(CodeCompletionSettings.PRESET_CUSTOM);
        s.setBaseUrl("https://example.com");
        s.setPath("/v1/completions");
        s.setApiKey("sk-roundtrip");
        s.setModel("deepseek-v4-pro");
        s.setMaxTokens(128);
        svc.setCodeCompletionSettings(s);

        CodeCompletionSettings loaded = svc.getCodeCompletionSettings();
        assertTrue(loaded.isEnabled());
        assertEquals(CodeCompletionSettings.PRESET_CUSTOM, loaded.getPreset());
        // normalize() now strips the trailing slash instead of adding one.
        assertEquals("https://example.com", loaded.getBaseUrl());
        assertEquals("/v1/completions", loaded.getPath());
        assertEquals("sk-roundtrip", loaded.getApiKey());
        assertEquals("deepseek-v4-pro", loaded.getModel());
        assertEquals(128, loaded.getMaxTokens());
    }

    @Test
    public void sectionIsPersistedOnDisk() throws Exception {
        Path home = newIsolatedHome();
        CodemossSettingsService svc = new CodemossSettingsService();

        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setEnabled(true);
        s.setModel("deepseek-v4-flash");
        svc.setCodeCompletionSettings(s);

        Path configFile = home.resolve(".codemoss/config.json");
        assertTrue("config.json should exist after a write", Files.exists(configFile));
        JsonObject config = JsonParser.parseString(Files.readString(configFile)).getAsJsonObject();
        assertTrue("codeCompletion section should exist", config.has("codeCompletion"));
        JsonObject section = config.getAsJsonObject("codeCompletion");
        assertTrue(section.get("enabled").getAsBoolean());
        assertEquals("deepseek-v4-flash", section.get("model").getAsString());
    }

    @Test
    public void clearingEnabledPersistsFalse() throws Exception {
        Path home = newIsolatedHome();
        CodemossSettingsService svc = new CodemossSettingsService();

        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setEnabled(true);
        svc.setCodeCompletionSettings(s);
        s.setEnabled(false);
        svc.setCodeCompletionSettings(s);

        JsonObject config = JsonParser.parseString(
                Files.readString(home.resolve(".codemoss/config.json"))).getAsJsonObject();
        assertFalse(config.getAsJsonObject("codeCompletion").get("enabled").getAsBoolean());
    }

    // ---------- helpers ----------

    private Path newIsolatedHome() throws Exception {
        Path home = Files.createTempDirectory("cc-settings-home");
        if (originalHome == null) {
            originalHome = getHome();
        }
        setHome(home.toString());
        Files.createDirectories(home.resolve(".codemoss"));
        return home;
    }

    private static String getHome() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private static void setHome(String home) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, home);
    }
}

package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

/**
 * Round-trip tests for the {@code grok.env} custom-environment persistence that
 * {@code GrokSDKBridge} injects into daemon processes. A saved key/value pair
 * must survive a fresh service instance, so configured env reaches later runs.
 */
public class CodemossSettingsServiceGrokEnvTest {

    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
        }
    }

    @Test
    public void grokEnvRoundTripsThroughTheConfigFile() throws Exception {
        useTemporaryHomeDirectory(Files.createTempDirectory("grok-env-roundtrip-home"));

        JsonObject env = new JsonObject();
        env.addProperty("GROK_MODELS_BASE_URL", "https://api.example.com");
        env.addProperty("GROK_HOME", "~/.custom-grok");

        new CodemossSettingsService().setGrokEnv(env);

        JsonObject readBack = new CodemossSettingsService().getGrokEnv();
        assertEquals("https://api.example.com", readBack.get("GROK_MODELS_BASE_URL").getAsString());
        assertEquals("~/.custom-grok", readBack.get("GROK_HOME").getAsString());
    }

    @Test
    public void emptyGrokEnvRemovesTheEntry() throws Exception {
        useTemporaryHomeDirectory(Files.createTempDirectory("grok-env-empty-home"));

        CodemossSettingsService writer = new CodemossSettingsService();
        JsonObject env = new JsonObject();
        env.addProperty("XAI_API_KEY", "then-removed");
        writer.setGrokEnv(env);
        writer.setGrokEnv(new JsonObject()); // empty → entry removed

        JsonObject readBack = new CodemossSettingsService().getGrokEnv();
        assertNotNull("empty env must deserialize as an empty object, not null", readBack);
        assertEquals(0, readBack.size());
    }

    @Test
    public void missingGrokSectionYieldsEmptyEnv() throws Exception {
        useTemporaryHomeDirectory(Files.createTempDirectory("grok-env-fresh-home"));

        JsonObject readBack = new CodemossSettingsService().getGrokEnv();
        assertNotNull(readBack);
        assertEquals(0, readBack.size());
    }

    // -- temp-home isolation (mirrors CodemossSettingsServiceCodexCliLoginTest) --

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

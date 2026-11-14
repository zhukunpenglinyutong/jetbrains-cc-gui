package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

public class CodemossSettingsServiceUiFontConfigTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void shouldDefaultUiFontConfigToFollowEditor() throws Exception {
        Path tempHome = Files.createTempDirectory("ui-font-default-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        JsonObject config = invokeGetUiFontConfig(service);

        assertEquals("followEditor", config.get("mode").getAsString());
        assertFalse(config.has("presetId"));
        assertFalse(config.has("customFontPath"));
    }

    /** Verifies that an absent scale preference stays unset instead of pinning the UI default. */
    @Test
    public void shouldLeaveFontSizeLevelUnsetByDefault() throws Exception {
        useTemporaryHomeDirectory(Files.createTempDirectory("font-size-default-home"));
        assertNull(new CodemossSettingsService().getFontSizeLevel());
    }

    /** Verifies that a new settings instance restores the persisted scale independently of font-family changes. */
    @Test
    public void shouldRestoreFontSizeLevelAfterRestart() throws Exception {
        useTemporaryHomeDirectory(Files.createTempDirectory("font-size-roundtrip-home"));
        CodemossSettingsService service = new CodemossSettingsService();
        for (int level = 1; level <= 6; level++) {
            service.setFontSizeLevel(level);
            service.setUiFontConfig("followEditor", null);
            assertEquals(Integer.valueOf(level), new CodemossSettingsService().getFontSizeLevel());
        }
    }

    /** Rejects invalid writes and malformed stored levels without replacing a valid preference. */
    @Test
    public void shouldRejectInvalidFontSizeLevels() throws Exception {
        Path home = Files.createTempDirectory("font-size-invalid-home");
        useTemporaryHomeDirectory(home);
        CodemossSettingsService service = new CodemossSettingsService();
        service.setFontSizeLevel(5);
        for (int invalid : new int[]{0, 7, -1}) {
            try {
                service.setFontSizeLevel(invalid);
                fail("Invalid level must not be saved");
            } catch (IllegalArgumentException expected) {
                assertEquals(Integer.valueOf(5), service.getFontSizeLevel());
            }
        }
        for (String value : new String[]{"null", "\"5\"", "true", "{}", "[]", "2.5", "0", "7", "6.000000000000000001", "1e999"}) {
            Files.writeString(home.resolve(".codemoss/config.json"), "{\"fontSizeLevel\":" + value + "}");
            assertNull(new CodemossSettingsService().getFontSizeLevel());
        }
    }

    /** Keeps a failed config read from triggering migration or replacing the existing configuration. */
    @Test
    public void shouldPreserveConfigWhenFontSizeReadFails() throws Exception {
        Path home = Files.createTempDirectory("font-size-unreadable-home");
        this.useTemporaryHomeDirectory(home);
        CodemossSettingsService service = new CodemossSettingsService();
        service.setFontSizeLevel(5);
        Path configPath = home.resolve(".codemoss/config.json");
        String brokenConfig = "{\"fontSizeLevel\":5,\"claude\":";
        Files.writeString(configPath, brokenConfig);

        try {
            service.getFontSizeLevel();
            fail("A failed read must not look like an unset preference");
        } catch (IOException expected) {
            assertEquals(brokenConfig, Files.readString(configPath));
        }
        try {
            service.setFontSizeLevel(6);
            fail("A scale update must not replace an unreadable configuration");
        } catch (IOException expected) {
            assertEquals(brokenConfig, Files.readString(configPath));
        }
    }

    @Test
    public void shouldOnlyPersistFollowEditorAndCustomUiFontConfig() throws Exception {
        Path tempHome = Files.createTempDirectory("ui-font-roundtrip-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();

        invokeSetUiFontConfig(service, "preset", null);
        JsonObject normalizedLegacyPresetConfig = invokeGetUiFontConfig(service);
        assertEquals("followEditor", normalizedLegacyPresetConfig.get("mode").getAsString());
        assertFalse(normalizedLegacyPresetConfig.has("presetId"));
        assertFalse(normalizedLegacyPresetConfig.has("customFontPath"));

        invokeSetUiFontConfig(service, "customFile", "/tmp/custom-font.ttf");
        JsonObject customConfig = invokeGetUiFontConfig(service);
        assertEquals("customFile", customConfig.get("mode").getAsString());
        assertEquals("/tmp/custom-font.ttf", customConfig.get("customFontPath").getAsString());
        assertFalse(customConfig.has("presetId"));
    }

    @Test
    public void shouldDefaultCodeFontConfigToFollowEditor() throws Exception {
        Path tempHome = Files.createTempDirectory("code-font-default-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        JsonObject config = invokeGetCodeFontConfig(service);

        assertEquals("followEditor", config.get("mode").getAsString());
        assertFalse(config.has("presetId"));
        assertFalse(config.has("customFontPath"));
    }

    @Test
    public void shouldOnlyPersistFollowEditorAndCustomCodeFontConfig() throws Exception {
        Path tempHome = Files.createTempDirectory("code-font-roundtrip-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();

        invokeSetCodeFontConfig(service, "preset", null);
        JsonObject normalizedLegacyPresetConfig = invokeGetCodeFontConfig(service);
        assertEquals("followEditor", normalizedLegacyPresetConfig.get("mode").getAsString());
        assertFalse(normalizedLegacyPresetConfig.has("presetId"));
        assertFalse(normalizedLegacyPresetConfig.has("customFontPath"));

        invokeSetCodeFontConfig(service, "customFile", "/tmp/custom-code-font.ttf");
        JsonObject customConfig = invokeGetCodeFontConfig(service);
        assertEquals("customFile", customConfig.get("mode").getAsString());
        assertEquals("/tmp/custom-code-font.ttf", customConfig.get("customFontPath").getAsString());
        assertFalse(customConfig.has("presetId"));
    }

    private JsonObject invokeGetUiFontConfig(CodemossSettingsService service) throws Exception {
        Method method;
        try {
            method = CodemossSettingsService.class.getMethod("getUiFontConfig");
        } catch (NoSuchMethodException e) {
            fail("CodemossSettingsService should expose getUiFontConfig()");
            throw e;
        }
        return (JsonObject) method.invoke(service);
    }

    private void invokeSetUiFontConfig(CodemossSettingsService service, String mode, String customFontPath)
            throws Exception {
        Method method;
        try {
            method = CodemossSettingsService.class.getMethod(
                    "setUiFontConfig",
                    String.class,
                    String.class
            );
        } catch (NoSuchMethodException e) {
            fail("CodemossSettingsService should expose setUiFontConfig(mode, customFontPath)");
            throw e;
        }
        method.invoke(service, mode, customFontPath);
    }

    private JsonObject invokeGetCodeFontConfig(CodemossSettingsService service) throws Exception {
        Method method;
        try {
            method = CodemossSettingsService.class.getMethod("getCodeFontConfig");
        } catch (NoSuchMethodException e) {
            fail("CodemossSettingsService should expose getCodeFontConfig()");
            throw e;
        }
        return (JsonObject) method.invoke(service);
    }

    private void invokeSetCodeFontConfig(CodemossSettingsService service, String mode, String customFontPath)
            throws Exception {
        Method method;
        try {
            method = CodemossSettingsService.class.getMethod(
                    "setCodeFontConfig",
                    String.class,
                    String.class
            );
        } catch (NoSuchMethodException e) {
            fail("CodemossSettingsService should expose setCodeFontConfig(mode, customFontPath)");
            throw e;
        }
        method.invoke(service, mode, customFontPath);
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
        Files.createDirectories(tempHome.resolve(".codemoss"));
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

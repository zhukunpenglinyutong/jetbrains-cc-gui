package com.github.claudecodegui.util;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.InputStream;
import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class FontConfigServiceUiFontResolutionTest {

    /** Verifies that the existing startup font payload carries the persisted global scale. */
    @Test
    public void shouldIncludeFontSizeLevelInStartupUiFontConfig() {
        CodemossSettingsService settings = new CodemossSettingsService() {
            /** Supplies the persisted UI typography without touching user configuration. */
            @Override
            public JsonObject getUiFontConfig() {
                return new JsonObject();
            }

            /** Supplies the persisted scale without touching user configuration. */
            @Override
            public Integer getFontSizeLevel() {
                return 6;
            }
        };
        assertEquals(6, FontConfigService.getResolvedUiFontConfig(settings).get("fontSizeLevel").getAsInt());
    }

    /** Preserves a valid scale when the separate font-family setting cannot be read. */
    @Test
    public void shouldRestoreFontSizeWhenUiFontReadFails() {
        CodemossSettingsService settings = new CodemossSettingsService() {
            /** Simulates an unavailable font-family preference. */
            @Override
            public JsonObject getUiFontConfig() throws IOException {
                throw new IOException("UI typography is unavailable");
            }

            /** Supplies a scale that remains independently readable. */
            @Override
            public Integer getFontSizeLevel() {
                return 5;
            }
        };
        assertEquals(5, FontConfigService.getResolvedUiFontConfig(settings).get("fontSizeLevel").getAsInt());
    }

    /** Keeps the chosen font family when scale recovery fails and avoids treating failure as an unset preference. */
    @Test
    public void shouldPreserveUiFontWhenFontSizeReadFails() {
        CodemossSettingsService settings = new CodemossSettingsService() {
            /** Supplies a custom font choice that must survive the unrelated scale failure. */
            @Override
            public JsonObject getUiFontConfig() {
                JsonObject config = new JsonObject();
                config.addProperty("mode", "customFile");
                config.addProperty("customFontPath", "/tmp/cc-gui-unavailable-custom-font.ttf");
                return config;
            }

            /** Simulates a failed scale read independently of font-family resolution. */
            @Override
            public Integer getFontSizeLevel() throws IOException {
                throw new IOException("Scale is unavailable");
            }
        };
        JsonObject resolved = FontConfigService.getResolvedUiFontConfig(settings);
        assertEquals("customFile", resolved.get("mode").getAsString());
        assertEquals("/tmp/cc-gui-unavailable-custom-font.ttf", resolved.get("customFontPath").getAsString());
        assertFalse(resolved.has("fontSizeLevel"));
    }

    @Test
    public void shouldResolveCodeFollowEditorModeUsingEditorTypography() throws Exception {
        JsonObject persisted = new JsonObject();
        persisted.addProperty("mode", "followEditor");

        JsonObject resolved = invokeResolveCodeFontConfig(persisted, createEditorFontConfig());

        assertEquals("followEditor", resolved.get("mode").getAsString());
        assertEquals("followEditor", resolved.get("effectiveMode").getAsString());
        assertEquals("Monaco", resolved.get("fontFamily").getAsString());
        assertEquals(14, resolved.get("fontSize").getAsInt());
        assertFalse(resolved.has("warning"));
    }

    @Test
    public void shouldResolveUiFollowEditorModeUsingIdeaUiTypography() throws Exception {
        JsonObject persisted = new JsonObject();
        persisted.addProperty("mode", "followEditor");

        JsonObject resolved = invokeResolveUiFontConfig(persisted, createUiFontConfig());

        assertEquals("followEditor", resolved.get("mode").getAsString());
        assertEquals("followEditor", resolved.get("effectiveMode").getAsString());
        assertEquals("Inter", resolved.get("fontFamily").getAsString());
        assertEquals(13, resolved.get("fontSize").getAsInt());
        assertFalse(resolved.has("warning"));
    }

    @Test
    public void shouldFallBackToEditorForLegacyPresetMode() throws Exception {
        JsonObject persisted = new JsonObject();
        persisted.addProperty("mode", "preset");
        persisted.addProperty("presetId", "jetbrains-mono");

        JsonObject resolved = invokeResolveCodeFontConfig(persisted, createEditorFontConfig());

        assertEquals("followEditor", resolved.get("mode").getAsString());
        assertEquals("followEditor", resolved.get("effectiveMode").getAsString());
        assertEquals("Monaco", resolved.get("fontFamily").getAsString());
        assertFalse(resolved.has("presetId"));
        assertFalse(resolved.has("fontBase64"));
        assertFalse(resolved.has("warning"));
    }

    @Test
    public void shouldFallBackToEditorWhenSavedCustomFontIsUnavailable() throws Exception {
        JsonObject persisted = new JsonObject();
        persisted.addProperty("mode", "customFile");
        persisted.addProperty("customFontPath", "/tmp/does-not-exist.ttf");

        JsonObject resolved = invokeResolveCodeFontConfig(persisted, createEditorFontConfig());

        assertEquals("customFile", resolved.get("mode").getAsString());
        assertEquals("followEditor", resolved.get("effectiveMode").getAsString());
        assertEquals("Monaco", resolved.get("fontFamily").getAsString());
        assertEquals("/tmp/does-not-exist.ttf", resolved.get("customFontPath").getAsString());
        assertNotNull(resolved.get("warning"));
        assertEquals("fontUnavailable", resolved.get("warningCode").getAsString());
    }

    @Test
    public void shouldRejectUnsupportedCustomFontExtensions() throws Exception {
        Method method;
        try {
            method = FontConfigService.class.getMethod("validateCustomUiFontFile", String.class);
        } catch (NoSuchMethodException e) {
            fail("FontConfigService should expose validateCustomUiFontFile(path)");
            throw e;
        }

        Object result = method.invoke(null, "/tmp/not-a-font.txt");
        Method validMethod = result.getClass().getMethod("valid");
        Method messageMethod = result.getClass().getMethod("errorMessage");

        assertFalse((Boolean) validMethod.invoke(result));
        assertTrue(((String) messageMethod.invoke(result)).toLowerCase().contains("ttf"));
    }

    @Test
    public void shouldAllowReadableCustomFontFilesLargerThanLegacyFiveMbLimit() throws Exception {
        Path largeFont = createLargeFontLikeFile();

        FontConfigService.ValidationResult result =
            FontConfigService.validateCustomUiFontFile(largeFont.toString());

        assertTrue(result.errorMessage(), result.valid());
    }

    @Test
    public void shouldResolveCustomFontUsingStreamedUrlWithoutEmbeddingBase64() throws Exception {
        Path largeFont = createLargeFontLikeFile();
        JsonObject persisted = new JsonObject();
        persisted.addProperty("mode", "customFile");
        persisted.addProperty("customFontPath", largeFont.toString());

        JsonObject resolved = invokeResolveCodeFontConfig(persisted, createEditorFontConfig());

        assertEquals("customFile", resolved.get("mode").getAsString());
        assertEquals("customFile", resolved.get("effectiveMode").getAsString());
        assertEquals("CC GUI Code Custom", resolved.get("fontFamily").getAsString());
        assertTrue(resolved.get("fontUrl").getAsString().startsWith("https://cc-gui-font.local/"));
        assertEquals("truetype", resolved.get("fontFormat").getAsString());
        assertFalse(resolved.has("fontBase64"));
        assertFalse(resolved.has("warning"));
    }

    @Test
    public void shouldResolveUiAndCodeFollowEditorFromIndependentSources() throws Exception {
        JsonObject persisted = new JsonObject();
        persisted.addProperty("mode", "followEditor");

        JsonObject resolvedUi = invokeResolveUiFontConfig(persisted, createUiFontConfig());
        JsonObject resolvedCode = invokeResolveCodeFontConfig(persisted, createEditorFontConfig());

        // Core contract of #1240: the very same persisted "followEditor" config must resolve
        // the UI font from the IDEA UI typography and the code font from the editor typography,
        // i.e. the two sources are independent and must not collapse back into one.
        assertEquals("Inter", resolvedUi.get("fontFamily").getAsString());
        assertEquals("Monaco", resolvedCode.get("fontFamily").getAsString());
        assertNotEquals(
                resolvedUi.get("fontFamily").getAsString(),
                resolvedCode.get("fontFamily").getAsString());
    }

    @Test
    public void shouldResolveUiCustomFileUsingUiCustomFamilyName() throws Exception {
        Path customFont = createLargeFontLikeFile();
        JsonObject persisted = new JsonObject();
        persisted.addProperty("mode", "customFile");
        persisted.addProperty("customFontPath", customFont.toString());

        JsonObject resolved = invokeResolveUiFontConfig(persisted, createUiFontConfig());

        // UI custom fonts must use the UI-specific family name so they never collide with the
        // code custom font family ("CC GUI Code Custom").
        assertEquals("customFile", resolved.get("effectiveMode").getAsString());
        assertEquals("CC GUI UI Custom", resolved.get("fontFamily").getAsString());
    }

    @Test
    public void shouldRejectNonExistentCustomFontFile() {
        FontConfigService.ValidationResult result =
                FontConfigService.validateCustomUiFontFile("/tmp/cc-gui-definitely-missing-font.ttf");

        assertFalse(result.errorMessage(), result.valid());
    }

    private JsonObject invokeResolveUiFontConfig(JsonObject persistedConfig, JsonObject uiFontConfig) throws Exception {
        Method method;
        try {
            method = FontConfigService.class.getMethod("resolveUiFontConfig", JsonObject.class, JsonObject.class);
        } catch (NoSuchMethodException e) {
            fail("FontConfigService should expose resolveUiFontConfig(persistedConfig, uiFontConfig)");
            throw e;
        }
        return (JsonObject) method.invoke(null, persistedConfig, uiFontConfig);
    }

    private JsonObject invokeResolveCodeFontConfig(JsonObject persistedConfig, JsonObject editorFontConfig) throws Exception {
        Method method;
        try {
            method = FontConfigService.class.getMethod("resolveCodeFontConfig", JsonObject.class, JsonObject.class);
        } catch (NoSuchMethodException e) {
            fail("FontConfigService should expose resolveCodeFontConfig(persistedConfig, editorFontConfig)");
            throw e;
        }
        return (JsonObject) method.invoke(null, persistedConfig, editorFontConfig);
    }

    private JsonObject createEditorFontConfig() {
        JsonObject editorConfig = new JsonObject();
        editorConfig.addProperty("fontFamily", "Monaco");
        editorConfig.addProperty("fontSize", 14);
        editorConfig.addProperty("lineSpacing", 1.35f);

        JsonArray fallbackFonts = new JsonArray();
        fallbackFonts.add("PingFang SC");
        editorConfig.add("fallbackFonts", fallbackFonts);
        return editorConfig;
    }

    private JsonObject createUiFontConfig() {
        JsonObject uiConfig = new JsonObject();
        uiConfig.addProperty("fontFamily", "Inter");
        uiConfig.addProperty("fontSize", 13);
        uiConfig.addProperty("lineSpacing", 1.0f);
        uiConfig.add("fallbackFonts", new JsonArray());
        return uiConfig;
    }

    private Path createLargeFontLikeFile() throws Exception {
        Path fontFile = Files.createTempFile("large-ui-font", ".ttf");
        try (InputStream inputStream = getClass().getResourceAsStream("/fonts/codicon.ttf")) {
            assertNotNull("Test font resource should exist", inputStream);
            Files.write(fontFile, inputStream.readAllBytes());
        }

        byte[] padding = new byte[6 * 1024 * 1024];
        Files.write(fontFile, padding, java.nio.file.StandardOpenOption.APPEND);
        fontFile.toFile().deleteOnExit();
        return fontFile;
    }
}

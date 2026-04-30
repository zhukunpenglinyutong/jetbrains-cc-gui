package com.github.claudecodegui.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class FontConfigServiceUiFontResolutionTest {

    @Test
    public void shouldResolveFollowEditorModeUsingEditorTypography() throws Exception {
        JsonObject persisted = new JsonObject();
        persisted.addProperty("mode", "followEditor");

        JsonObject resolved = invokeResolveUiFontConfig(persisted, createEditorFontConfig());

        assertEquals("followEditor", resolved.get("mode").getAsString());
        assertEquals("followEditor", resolved.get("effectiveMode").getAsString());
        assertEquals("Monaco", resolved.get("fontFamily").getAsString());
        assertEquals(14, resolved.get("fontSize").getAsInt());
        assertFalse(resolved.has("warning"));
    }

    @Test
    public void shouldFallBackToEditorForLegacyPresetMode() throws Exception {
        JsonObject persisted = new JsonObject();
        persisted.addProperty("mode", "preset");
        persisted.addProperty("presetId", "jetbrains-mono");

        JsonObject resolved = invokeResolveUiFontConfig(persisted, createEditorFontConfig());

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

        JsonObject resolved = invokeResolveUiFontConfig(persisted, createEditorFontConfig());

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

        JsonObject resolved = invokeResolveUiFontConfig(persisted, createEditorFontConfig());

        assertEquals("customFile", resolved.get("mode").getAsString());
        assertEquals("customFile", resolved.get("effectiveMode").getAsString());
        assertEquals("CC GUI Custom", resolved.get("fontFamily").getAsString());
        assertTrue(resolved.get("fontUrl").getAsString().startsWith("https://cc-gui-font.local/"));
        assertEquals("truetype", resolved.get("fontFormat").getAsString());
        assertFalse(resolved.has("fontBase64"));
        assertFalse(resolved.has("warning"));
    }

    private JsonObject invokeResolveUiFontConfig(JsonObject persistedConfig, JsonObject editorFontConfig) throws Exception {
        Method method;
        try {
            method = FontConfigService.class.getMethod("resolveUiFontConfig", JsonObject.class, JsonObject.class);
        } catch (NoSuchMethodException e) {
            fail("FontConfigService should expose resolveUiFontConfig(persistedConfig, editorFontConfig)");
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

    private Path createLargeFontLikeFile() throws Exception {
        Path fontFile = Files.createTempFile("large-ui-font", ".ttf");
        try (InputStream inputStream = getClass().getResourceAsStream("/libs/codicon.ttf")) {
            assertNotNull("Test font resource should exist", inputStream);
            Files.write(fontFile, inputStream.readAllBytes());
        }

        byte[] padding = new byte[6 * 1024 * 1024];
        Files.write(fontFile, padding, java.nio.file.StandardOpenOption.APPEND);
        fontFile.toFile().deleteOnExit();
        return fontFile;
    }
}

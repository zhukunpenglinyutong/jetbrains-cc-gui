package com.github.claudecodegui.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.lang.reflect.Method;

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
}

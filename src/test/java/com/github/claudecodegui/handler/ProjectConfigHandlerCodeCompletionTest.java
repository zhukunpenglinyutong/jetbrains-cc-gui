package com.github.claudecodegui.handler;

import com.github.claudecodegui.settings.CodeCompletionSettings;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;

/**
 * The "test connection" probe must measure the settings the user is looking at.
 *
 * <p>It used to read the persisted config, so switching platform and testing
 * answered with the previously saved endpoint's result — the one diagnostic
 * this feature has reported on the wrong configuration.
 */
public class ProjectConfigHandlerCodeCompletionTest {

    private static CodeCompletionSettings stored() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setEnabled(true);
        s.setPreset(CodeCompletionSettings.PRESET_CUSTOM);
        s.setBaseUrl("https://api.siliconflow.cn");
        s.setPath("/v1/completions");
        s.setApiKey("sk-stored-secret");
        s.setModel("deepseek-ai/DeepSeek-V4-Flash");
        return s;
    }

    private static String draftJson(String baseUrl, String path, String apiKey) {
        JsonObject o = new JsonObject();
        o.addProperty("enabled", true);
        o.addProperty("preset", CodeCompletionSettings.PRESET_DEEPSEEK);
        o.addProperty("baseUrl", baseUrl);
        o.addProperty("path", path);
        o.addProperty("apiKey", apiKey);
        o.addProperty("model", "deepseek-flash");
        return o.toString();
    }

    @Test
    public void testsTheDraftTheWebviewIsShowing() {
        CodeCompletionSettings resolved = ProjectConfigHandler.draftOrStoredSettings(
                draftJson("https://api.deepseek.com", "/beta/completions", "sk-live-draft"),
                stored());

        assertEquals("https://api.deepseek.com", resolved.getBaseUrl());
        assertEquals("/beta/completions", resolved.getPath());
        assertEquals("deepseek-flash", resolved.getModel());
        assertEquals(CodeCompletionSettings.PRESET_DEEPSEEK, resolved.getPreset());
        assertEquals("sk-live-draft", resolved.getApiKey());
    }

    @Test
    public void aMaskedDraftKeyKeepsTheStoredOne() {
        CodeCompletionSettings resolved = ProjectConfigHandler.draftOrStoredSettings(
                draftJson("https://api.deepseek.com", "/beta/completions", "sk-s****cret"),
                stored());

        assertEquals("sk-stored-secret", resolved.getApiKey());
        assertEquals("https://api.deepseek.com", resolved.getBaseUrl());
    }

    @Test
    public void anEmptyDraftKeyKeepsTheStoredOne() {
        CodeCompletionSettings resolved = ProjectConfigHandler.draftOrStoredSettings(
                draftJson("https://api.deepseek.com", "/beta/completions", ""),
                stored());

        assertEquals("sk-stored-secret", resolved.getApiKey());
    }

    @Test
    public void missingOrUnreadableDraftFallsBackToTheStoredSettings() {
        CodeCompletionSettings persisted = stored();

        assertSame(persisted, ProjectConfigHandler.draftOrStoredSettings(null, persisted));
        assertSame(persisted, ProjectConfigHandler.draftOrStoredSettings("   ", persisted));
        assertSame(persisted, ProjectConfigHandler.draftOrStoredSettings("not json at all", persisted));
    }
}

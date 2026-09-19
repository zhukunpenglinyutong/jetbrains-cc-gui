package com.github.claudecodegui.settings;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.Arrays;

import static org.junit.Assert.*;

public class CodeCompletionSettingsTest {

    @Test
    public void defaultsMatchSpec() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        assertFalse(s.isEnabled());
        assertEquals(CodeCompletionSettings.PRESET_DEEPSEEK, s.getPreset());
        assertEquals("https://api.deepseek.com", s.getBaseUrl());
        assertEquals(CodeCompletionSettings.DEEPSEEK_PATH, s.getPath());
        assertEquals("", s.getApiKey());
        assertEquals("deepseek-flash", s.getModel());
        assertEquals(256, s.getMaxTokens());
        assertEquals(1.0, s.getTemperature(), 0.0001);
        assertEquals(1.0, s.getTopP(), 0.0001);
        assertEquals(Arrays.asList("\n\n"), s.getStop());
        assertFalse(s.isIgnoreEos());
        assertEquals(300, s.getDebounceMs());
    }

    @Test
    public void rejectsInvalidPreset() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setPreset("followClaude");
        s.normalize();
        assertEquals(CodeCompletionSettings.PRESET_DEEPSEEK, s.getPreset());
    }

    @Test
    public void acceptsSiliconFlowPreset() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setPreset(CodeCompletionSettings.PRESET_SILICONFLOW);
        s.normalize();
        assertEquals(CodeCompletionSettings.PRESET_SILICONFLOW, s.getPreset());
    }

    @Test
    public void rejectsInvalidMaxTokens() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setMaxTokens(-5);
        s.normalize();
        assertEquals(256, s.getMaxTokens());
    }

    @Test
    public void stripsTrailingSlashFromBaseUrl() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setBaseUrl("https://example.com/");
        s.normalize();
        assertEquals("https://example.com", s.getBaseUrl());
    }

    @Test
    public void rejectsOutOfRangeTemperature() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setTemperature(99.0);
        s.normalize();
        assertEquals(1.0, s.getTemperature(), 0.0001);
    }

    @Test
    public void roundTripsThroughJson() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setEnabled(true);
        s.setPreset(CodeCompletionSettings.PRESET_CUSTOM);
        s.setBaseUrl("https://example.com");
        s.setPath("/v1/completions");
        s.setApiKey("sk-test");
        s.setModel("deepseek-v4-pro");
        s.setMaxTokens(128);
        s.setStop(Arrays.asList("END", "STOP"));
        // Normalize so the source matches what fromJson (which normalizes) produces.
        s.normalize();
        CodeCompletionSettings copy = CodeCompletionSettings.fromJson(s.toJson());
        assertEquals(s, copy);
    }

    @Test
    public void fromJsonStringHandlesEmptyAndMalformed() {
        CodeCompletionSettings empty = CodeCompletionSettings.fromJsonString("");
        assertEquals(CodeCompletionSettings.PRESET_DEEPSEEK, empty.getPreset());
        CodeCompletionSettings malformed = CodeCompletionSettings.fromJsonString("{not valid json");
        assertEquals(CodeCompletionSettings.PRESET_DEEPSEEK, malformed.getPreset());
    }

    @Test
    public void migratesLegacySourceKeyToPreset() {
        JsonObject legacy = new JsonObject();
        legacy.addProperty("source", "custom");
        legacy.addProperty("baseUrl", "https://api.siliconflow.cn");
        CodeCompletionSettings s = CodeCompletionSettings.fromJson(legacy);
        assertEquals(CodeCompletionSettings.PRESET_CUSTOM, s.getPreset());
        assertEquals(CodeCompletionSettings.DEFAULT_PATH, s.getPath());
    }

    @Test
    public void derivesDeepseekPathFromHostEvenWhenPresetIsCustom() {
        // Regression: the live config is source=custom + baseUrl=https://api.deepseek.com/
        // which talks to the official /beta/completions. Deriving from preset alone
        // would push it to /v1/completions and break a working setup.
        JsonObject legacy = new JsonObject();
        legacy.addProperty("source", "custom");
        legacy.addProperty("baseUrl", "https://api.deepseek.com/");
        CodeCompletionSettings s = CodeCompletionSettings.fromJson(legacy);
        assertEquals("/beta/completions", s.getPath());
    }

    @Test
    public void keepsExplicitPath() {
        JsonObject o = new JsonObject();
        o.addProperty("baseUrl", "https://example.com");
        o.addProperty("path", "completions");
        CodeCompletionSettings s = CodeCompletionSettings.fromJson(o);
        assertEquals("/completions", s.getPath());
    }

    @Test
    public void rejectsAbsoluteUrlAsPath() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setPath("https://evil.example.com/v1/completions");
        s.normalize();
        assertEquals(CodeCompletionSettings.DEEPSEEK_PATH, s.getPath());
    }
}

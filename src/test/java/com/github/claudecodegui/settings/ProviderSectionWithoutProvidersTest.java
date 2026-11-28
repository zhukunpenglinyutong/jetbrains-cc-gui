package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ProviderSectionWithoutProvidersTest {

    private final Gson gson = new Gson();

    @Test
    public void addsAClaudeProvider() throws Exception {
        AtomicReference<JsonObject> config = configWithSectionOnly("claude");
        this.claudeManager(config).addClaudeProvider(provider());
        assertAddedKeepingTheSection(config.get(), "claude");
    }

    @Test
    public void savesAClaudeProvider() throws Exception {
        AtomicReference<JsonObject> config = configWithSectionOnly("claude");
        this.claudeManager(config).saveClaudeProvider(provider());
        assertAddedKeepingTheSection(config.get(), "claude");
    }

    @Test
    public void addsACodexProvider() throws Exception {
        AtomicReference<JsonObject> config = configWithSectionOnly("codex");
        this.codexManager(config).addCodexProvider(provider());
        assertAddedKeepingTheSection(config.get(), "codex");
    }

    @Test
    public void savesACodexProvider() throws Exception {
        AtomicReference<JsonObject> config = configWithSectionOnly("codex");
        this.codexManager(config).saveCodexProvider(provider());
        assertAddedKeepingTheSection(config.get(), "codex");
    }

    private ProviderManager claudeManager(AtomicReference<JsonObject> config) {
        return new ProviderManager(this.gson, ignored -> config.get().deepCopy(), config::set, null,
                new ClaudeSettingsManager(this.gson, null));
    }

    private CodexProviderManager codexManager(AtomicReference<JsonObject> config) {
        return new CodexProviderManager(ignored -> config.get().deepCopy(), config::set, new ConfigPathManager(),
                new CodexSettingsManager(this.gson));
    }

    private static AtomicReference<JsonObject> configWithSectionOnly(String section) {
        return new AtomicReference<>(JsonParser.parseString("{\"" + section + "\":{\"current\":\"kept\"}}")
                .getAsJsonObject());
    }

    private static JsonObject provider() {
        return JsonParser.parseString("{\"id\":\"test\",\"name\":\"test\"}").getAsJsonObject();
    }

    private static void assertAddedKeepingTheSection(JsonObject config, String section) {
        JsonObject stored = config.getAsJsonObject(section);
        assertEquals("kept", stored.get("current").getAsString());
        assertTrue(stored.getAsJsonObject("providers").has("test"));
    }
}

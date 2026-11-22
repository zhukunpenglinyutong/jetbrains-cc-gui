package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;

/** Import must preserve the effective selection even after the real provider read/refresh path runs. */
public class ProviderBackupSelectionTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private Field cachedHome;
    private Object previousHome;
    private Path configPath;

    @Before
    public void useIsolatedHome() throws Exception {
        cachedHome = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        cachedHome.setAccessible(true);
        previousHome = cachedHome.get(null);
        cachedHome.set(null, folder.getRoot().getAbsolutePath());
        configPath = folder.getRoot().toPath().resolve(".codemoss/config.json");
        Files.createDirectories(configPath.getParent());
    }

    @After
    public void restoreHome() throws Exception {
        cachedHome.set(null, previousHome);
    }

    @Test
    public void emptyClaudeListStaysInactiveAfterImportAndRefresh() throws Exception {
        for (JsonElement current : Arrays.asList(null, JsonNull.INSTANCE, new JsonPrimitive(""))) {
            JsonObject original = config("claude", current);
            JsonObject before = original.deepCopy();
            var merged = ProviderBackupService.merge(original, "claude", payload(provider("claude", "new")));
            assertEquals(1, merged.imported());
            assertEquals("", activeClaudeIdAfterRefresh(merged.config()));
            assertEquals("", merged.config().getAsJsonObject("claude").get("current").getAsString());
            assertEquals(before, original);
        }
    }

    @Test
    public void legacyClaudeDefaultIsResolvedFromThePreImportList() throws Exception {
        for (JsonElement current : Arrays.asList(null, JsonNull.INSTANCE)) {
            JsonObject original = config("claude", current, provider("claude", "old-first"), provider("claude", "old-second"));
            // Match ProviderManager's legacy fallback, which uses stored key order, not display order.
            original.getAsJsonObject("claude").add("providerOrder", JsonParser.parseString("[\"old-second\",\"old-first\"]"));
            String before = activeClaudeIdAfterRefresh(original);
            var merged = ProviderBackupService.merge(original, "claude", payload(provider("claude", "new")));
            assertEquals("old-first", before);
            assertEquals(before, activeClaudeIdAfterRefresh(merged.config()));
            assertEquals(original.getAsJsonObject("claude").get("providerOrder"),
                    merged.config().getAsJsonObject("claude").get("providerOrder"));
        }
    }

    @Test
    public void explicitClaudeSelectionIsPreservedIncludingDisabledAndVirtualModes() throws Exception {
        for (String current : List.of("", "old-second", ProviderManager.LOCAL_SETTINGS_PROVIDER_ID, ProviderManager.CLI_LOGIN_PROVIDER_ID)) {
            JsonObject original = config("claude", new JsonPrimitive(current), provider("claude", "old-first"), provider("claude", "old-second"));
            var merged = ProviderBackupService.merge(original, "claude", payload(provider("claude", "new")));
            assertEquals(current, merged.config().getAsJsonObject("claude").get("current").getAsString());
            assertEquals(current, activeClaudeIdAfterRefresh(merged.config()));
            assertEquals(original.get("unrelated"), merged.config().get("unrelated"));
            assertTrue(merged.config().getAsJsonObject("claude").get("cliLoginAuthorized").getAsBoolean());
        }
    }

    @Test
    public void nullSelectionIsPersistedAsInactiveBeforeTheFirstRefresh() throws Exception {
        Path path = configPath;
        Files.writeString(path, config("claude", JsonNull.INSTANCE).toString());
        var imported = new CodemossSettingsService().importProviderBackup("claude", payload(provider("claude", "new")));
        JsonObject stored = JsonParser.parseString(Files.readString(path)).getAsJsonObject();
        assertEquals(1, imported.imported());
        assertEquals("", stored.getAsJsonObject("claude").get("current").getAsString());
        assertEquals("", activeClaudeIdAfterRefresh(stored));
    }

    @Test
    public void duplicateOnlyLegacyImportDoesNotRewriteTheFile() throws Exception {
        JsonObject existing = provider("claude", "old");
        JsonObject original = config("claude", JsonNull.INSTANCE, existing);
        Path path = configPath;
        Files.writeString(path, original.toString());
        var modified = Files.getLastModifiedTime(path);
        var imported = new CodemossSettingsService().importProviderBackup("claude", payload(existing));
        assertEquals(0, imported.imported());
        assertEquals(original.toString(), Files.readString(path));
        assertEquals(modified, Files.getLastModifiedTime(path));
        assertEquals("old", activeClaudeIdAfterRefresh(imported.config()));
    }

    @Test
    public void codexUnsetSelectionRemainsInactiveAndExplicitSelectionSurvives() throws Exception {
        for (JsonElement current : Arrays.asList(null, JsonNull.INSTANCE, new JsonPrimitive(""), new JsonPrimitive("old"))) {
            JsonObject original = config("codex", current, provider("codex", "old"));
            var merged = ProviderBackupService.merge(original, "codex", payload(provider("codex", "new")));
            AtomicReference<JsonObject> stored = new AtomicReference<>(merged.config());
            CodexProviderManager manager = new CodexProviderManager(ignored -> stored.get().deepCopy(), stored::set, null, null);
            manager.getCodexProviders();
            JsonObject active = manager.getActiveCodexProvider();
            String expected = current != null && current.isJsonPrimitive() ? current.getAsString() : "";
            assertEquals(expected, active == null ? "" : active.get("id").getAsString());
        }
    }

    private static String activeClaudeIdAfterRefresh(JsonObject initial) {
        AtomicReference<JsonObject> stored = new AtomicReference<>(initial.deepCopy());
        Gson gson = new Gson();
        ClaudeSettingsManager localSettings = new ClaudeSettingsManager(gson, null) {
            @Override
            public JsonObject readClaudeSettings() {
                return new JsonObject(); // Never read the user's actual CLI settings in this fixture.
            }
        };
        ProviderManager manager = new ProviderManager(gson, ignored -> stored.get().deepCopy(), stored::set, null, localSettings);
        manager.getClaudeProviders();
        JsonObject active = manager.getActiveClaudeProvider();
        return active == null ? "" : active.get("id").getAsString();
    }

    private static JsonObject provider(String engine, String id) {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", id);
        provider.addProperty("name", id);
        if ("claude".equals(engine)) {
            JsonObject settings = new JsonObject();
            settings.addProperty("model", id);
            provider.add("settingsConfig", settings);
        } else {
            provider.addProperty("configToml", "model = '" + id + "'");
            provider.addProperty("authJson", "{}");
        }
        return provider;
    }

    private static JsonObject config(String engine, JsonElement current, JsonObject... saved) {
        JsonObject providers = new JsonObject();
        for (JsonObject provider : saved) providers.add(provider.get("id").getAsString(), provider);
        JsonObject section = new JsonObject();
        section.add("providers", providers);
        if (current != null) section.add("current", current);
        section.addProperty("cliLoginAuthorized", true);
        JsonObject config = new JsonObject();
        config.add(engine, section);
        config.add("unrelated", JsonParser.parseString("{\"keep\":null}"));
        return config;
    }

    private static JsonObject payload(JsonObject provider) {
        JsonArray providers = new JsonArray();
        providers.add(provider);
        JsonObject payload = new JsonObject();
        payload.add("providers", providers);
        return payload;
    }
}

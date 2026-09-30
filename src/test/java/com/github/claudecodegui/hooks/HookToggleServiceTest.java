package com.github.claudecodegui.hooks;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.Assume;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/** Tests reversible CCGUI-managed Hook toggles. */
public class HookToggleServiceTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void togglesClaudeHookAndRestoresItFromManagedState() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path settings = Files.createDirectories(home.resolve(".claude")).resolve("settings.json");
        Files.writeString(settings, """
                {
                  "hooks": {
                    "PreToolUse": [{
                      "matcher": "Bash",
                      "hooks": [{"type": "command", "command": "echo hello"}]
                    }]
                  }
                }
                """, StandardCharsets.UTF_8);
        JsonObject item = new HookCatalogService(home).scan(null).getAsJsonArray("items")
                .get(0).getAsJsonObject();
        HookToggleService service = new HookToggleService(home);
        JsonObject disable = service.toggle(null, request(item, false));

        assertTrue(disable.toString(), disable.get("success").getAsBoolean());
        assertFalse(Files.readString(settings).contains("echo hello"));
        JsonObject disabledItem = findDisabled(new HookCatalogService(home).scan(null).getAsJsonArray("items"));
        assertNotNull(disabledItem);
        assertFalse(disabledItem.get("enabled").getAsBoolean());

        JsonObject enableRequest = request(disabledItem, true);
        JsonObject enable = service.toggle(null, enableRequest);
        assertTrue(enable.toString(), enable.get("success").getAsBoolean());
        assertTrue(Files.readString(settings).contains("echo hello"));
    }

    @Test
    public void quarantinesAndRestoresCodemossScript() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path script = Files.createDirectories(home.resolve(".codemoss").resolve("hooks"))
                .resolve("before.sh");
        Files.writeString(script, "#!/bin/sh\necho ready\n", StandardCharsets.UTF_8);
        JsonObject item = new HookCatalogService(home).scan(null).getAsJsonArray("items")
                .get(0).getAsJsonObject();
        HookToggleService service = new HookToggleService(home);

        JsonObject disable = service.toggle(null, request(item, false));
        assertTrue(disable.toString(), disable.get("success").getAsBoolean());
        assertFalse(Files.exists(script));
        JsonObject disabledItem = findItem(new HookCatalogService(home).scan(null).getAsJsonArray("items"),
                item.get("sourceId").getAsString());
        assertNotNull(disabledItem);
        assertFalse(disabledItem.get("enabled").getAsBoolean());

        JsonObject enable = service.toggle(null, request(disabledItem, true));
        assertTrue(enable.toString(), enable.get("success").getAsBoolean());
        assertTrue(Files.exists(script));
    }

    @Test
    public void rejectsCorruptStateWithoutOverwritingRecoveryData() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path claude = Files.createDirectories(home.resolve(".claude"));
        Path settings = claude.resolve("settings.json");
        String original = "{\"hooks\":{\"Stop\":[{\"type\":\"command\",\"command\":\"echo done\"}]}}";
        Files.writeString(settings, original, StandardCharsets.UTF_8);
        Path state = claude.resolve(".ccgui-hooks-state.json");
        Files.writeString(state, "not-json", StandardCharsets.UTF_8);
        JsonObject item = new HookCatalogService(home).scan(null).getAsJsonArray("items")
                .get(0).getAsJsonObject();

        JsonObject result = new HookToggleService(home).toggle(null, request(item, false));

        assertFalse(result.get("success").getAsBoolean());
        assertTrue(Files.readString(state).equals("not-json"));
        assertTrue(Files.readString(settings).equals(original));
    }

    @Test
    public void targetsOneOfTwoIdenticalClaudeHooksByManagedKey() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path settings = Files.createDirectories(home.resolve(".claude")).resolve("settings.json");
        Files.writeString(settings, """
                {"hooks":{"Stop":[
                  {"type":"command","command":"echo same"},
                  {"type":"command","command":"echo same"}
                ]}}
                """, StandardCharsets.UTF_8);
        JsonArray items = new HookCatalogService(home).scan(null).getAsJsonArray("items");
        JsonObject second = items.get(1).getAsJsonObject();

        JsonObject disabled = new HookToggleService(home).toggle(null, request(second, false));

        assertTrue(disabled.toString(), disabled.get("success").getAsBoolean());
        JsonArray activeHooks = JsonParser.parseString(Files.readString(settings)).getAsJsonObject()
                .getAsJsonObject("hooks").getAsJsonArray("Stop");
        assertTrue(activeHooks.size() == 1);
        JsonArray rescanned = new HookCatalogService(home).scan(null).getAsJsonArray("items");
        assertTrue(rescanned.size() == 2);
        assertTrue(findDisabled(rescanned) != null);
    }

    @Test
    public void keepsDisabledScriptDiscoverableWhenActiveDirectoryIsRemoved() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path hooks = Files.createDirectories(home.resolve(".codemoss").resolve("hooks"));
        Path script = hooks.resolve("before.sh");
        Files.writeString(script, "echo ready", StandardCharsets.UTF_8);
        JsonObject item = new HookCatalogService(home).scan(null).getAsJsonArray("items")
                .get(0).getAsJsonObject();
        assertTrue(new HookToggleService(home).toggle(null, request(item, false))
                .get("success").getAsBoolean());
        Files.delete(hooks);

        JsonObject disabled = findDisabled(new HookCatalogService(home).scan(null).getAsJsonArray("items"));
        assertNotNull(disabled);
    }

    @Test
    public void togglesScriptThroughDirectoryLink() throws Exception {
        Path realHome = temporaryFolder.newFolder("real-home").toPath();
        Path aliasHome = temporaryFolder.getRoot().toPath().resolve("home-alias");
        try {
            Files.createSymbolicLink(aliasHome, realHome);
        } catch (UnsupportedOperationException | SecurityException | java.io.IOException e) {
            Assume.assumeTrue("Directory links are unavailable", false);
        }
        Path hook = Files.createDirectories(realHome.resolve(".codemoss").resolve("hooks"))
                .resolve("before.sh");
        Files.writeString(hook, "echo ready\n", StandardCharsets.UTF_8);
        JsonObject item = new HookCatalogService(aliasHome).scan(null).getAsJsonArray("items")
                .get(0).getAsJsonObject();

        JsonObject result = new HookToggleService(aliasHome).toggle(null, request(item, false));

        assertTrue(result.toString(), result.get("success").getAsBoolean());
        assertFalse(Files.exists(hook));
    }

    @Test
    public void togglesCodexConfigHookWithoutReformattingConfig() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path config = Files.createDirectories(home.resolve(".codex")).resolve("config.toml");
        Files.writeString(config, """
                # preserve comment
                [features]
                hooks = true

                [[hooks.pre_tool_use]]
                matcher = "Bash"
                enabled = true
                hooks = [{ type = "command", command = "python", args = ["guard.py"] }]

                [model_aliases]
                fast = "gpt-test"
                """, StandardCharsets.UTF_8);
        JsonObject item = new HookCatalogService(home).scan(null).getAsJsonArray("items")
                .get(0).getAsJsonObject();

        JsonObject result = new HookToggleService(home).toggle(null, request(item, false));

        assertTrue(result.toString(), result.get("success").getAsBoolean());
        assertTrue(Files.readString(config).contains("enabled = false"));
        assertTrue(Files.readString(config).contains("# preserve comment"));
        assertTrue(Files.readString(config).contains("fast = \"gpt-test\""));
        JsonObject rescanned = new HookCatalogService(home).scan(null).getAsJsonArray("items")
                .get(0).getAsJsonObject();
        assertFalse(rescanned.get("enabled").getAsBoolean());
    }

    private static JsonObject request(JsonObject item, boolean enabled) {
        JsonObject request = new JsonObject();
        request.addProperty("provider", item.get("provider").getAsString());
        request.addProperty("scope", item.get("scope").getAsString());
        request.addProperty("event", item.get("event").getAsString());
        if (item.has("matcher")) {
            request.addProperty("matcher", item.get("matcher").getAsString());
        }
        request.addProperty("sourceId", item.get("sourceId").getAsString());
        if (item.has("managedKey")) {
            request.addProperty("managedKey", item.get("managedKey").getAsString());
        }
        request.addProperty("requestId", "test-request");
        request.addProperty("location", item.get("rawLocation").getAsString());
        request.addProperty("format", item.get("format").getAsString());
        request.addProperty("expectedRevision", item.get("revision").getAsString());
        request.addProperty("enabled", enabled);
        return request;
    }

    private static JsonObject findItem(JsonArray items, String sourceId) {
        for (var element : items) {
            JsonObject item = element.getAsJsonObject();
            if (sourceId.equals(item.get("sourceId").getAsString())) {
                return item;
            }
        }
        return null;
    }

    private static JsonObject findDisabled(JsonArray items) {
        for (var element : items) {
            JsonObject item = element.getAsJsonObject();
            if (!item.get("enabled").getAsBoolean()) {
                return item;
            }
        }
        return null;
    }
}

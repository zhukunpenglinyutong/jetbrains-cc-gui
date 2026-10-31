package com.github.claudecodegui.hooks;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/** Tests reversible CCGUI-managed Hook toggles. */
public class HookToggleServiceTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void matcherlessWrappedHookKeepsItsStructureAndUnrelatedSettingsBytes() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path settings = Files.createDirectories(home.resolve(".claude")).resolve("settings.json");
        String prefix = "{\r\n    \"nullable\": null,\r\n    \"url\": \"https://example.test/?a=1&b=<tag>\",\r\n    \"hooks\": ";
        String suffix = ",\r\n    \"custom\": { \"hooks\": \"escaped \\\" value }\", \"unicode\": \"\\u4f60\" }\r\n}\r\n";
        Files.writeString(settings, prefix + "{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"echo ready\",\"custom\":null}]}]}" + suffix);
        HookCatalogService catalog = new HookCatalogService(home);
        HookToggleService toggle = new HookToggleService(home);
        JsonObject active = catalog.scan(null).getAsJsonArray("items").get(0).getAsJsonObject();
        assertTrue(toggle.toggle(null, request(active, false)).get("success").getAsBoolean());
        JsonObject disabled = findDisabled(catalog.scan(null).getAsJsonArray("items"));
        assertNotNull(disabled);
        assertTrue(toggle.toggle(null, request(disabled, true)).get("success").getAsBoolean());

        String restored = Files.readString(settings);
        assertTrue(restored.startsWith(prefix));
        assertTrue(restored.endsWith(suffix));
        assertFalse(restored.replace("\r\n", "").contains("\n"));
        JsonArray stop = JsonParser.parseString(restored).getAsJsonObject().getAsJsonObject("hooks").getAsJsonArray("Stop");
        assertEquals(1, stop.size());
        JsonObject group = stop.get(0).getAsJsonObject();
        assertFalse(group.has("matcher"));
        assertFalse(group.has("command"));
        JsonArray nested = group.getAsJsonArray("hooks");
        assertEquals(1, nested.size());
        assertTrue(nested.get(0).getAsJsonObject().get("custom").isJsonNull());
    }

    @Test
    public void restoresMultipleHandlersInTheirOriginalOrder() throws Exception {
        for (boolean wrapped : new boolean[] {false, true}) {
            for (String order : new String[] {"AB", "BA"}) {
                Path home = temporaryFolder.newFolder().toPath();
                Path settings = Files.createDirectories(home.resolve(".claude")).resolve("settings.json");
                String handlers = "{\"type\":\"command\",\"command\":\"A\"},{\"type\":\"command\",\"command\":\"B\"},"
                        + "{\"type\":\"command\",\"command\":\"C\"}";
                Files.writeString(settings, "{\"hooks\":{\"Stop\":[" + (wrapped ? "{\"hooks\":[" + handlers + "]}" : handlers) + "]}}");
                HookCatalogService catalog = new HookCatalogService(home);
                HookToggleService service = new HookToggleService(home);
                for (String command : new String[] {"A", "B"}) {
                    JsonObject item = commandItem(catalog.scan(null).getAsJsonArray("items"), command);
                    assertTrue(service.toggle(null, request(item, false)).get("success").getAsBoolean());
                }
                for (char command : order.toCharArray()) {
                    JsonObject item = commandItem(catalog.scan(null).getAsJsonArray("items"), String.valueOf(command));
                    assertTrue(service.toggle(null, request(item, true)).get("success").getAsBoolean());
                }
                JsonArray array = JsonParser.parseString(Files.readString(settings)).getAsJsonObject()
                        .getAsJsonObject("hooks").getAsJsonArray("Stop");
                if (wrapped) {
                    array = array.get(0).getAsJsonObject().getAsJsonArray("hooks");
                }
                assertEquals(3, array.size());
                for (int index = 0; index < 3; index++) {
                    assertEquals(String.valueOf((char) ('A' + index)), array.get(index).getAsJsonObject().get("command").getAsString());
                }
            }
        }
    }

    private static JsonObject commandItem(JsonArray items, String command) {
        for (var item : items) {
            if (command.equals(item.getAsJsonObject().get("command").getAsString())) {
                return item.getAsJsonObject();
            }
        }
        throw new AssertionError("Hook fixture missing: " + command);
    }

    @Test
    public void nonCommandClaudeHandlersDoNotRequireCommandFields() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path settings = Files.createDirectories(home.resolve(".claude")).resolve("settings.json");
        Files.writeString(settings, """
                {"hooks":{"Stop":[{"hooks":[
                  {"type":"prompt","prompt":"Review the result"},
                  {"type":"agent","prompt":"Check completion"},
                  {"type":"http","url":"http://localhost:8000/hook"},
                  {"type":"mcp_tool","server":"local","tool":"review"}
                ]}]}}
                """);
        JsonArray items = new HookCatalogService(home).scan(null).getAsJsonArray("items");
        assertEquals(4, items.size());
        for (var item : items) {
            assertEquals(0, item.getAsJsonObject().getAsJsonArray("validationIssues").size());
        }
    }

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
    public void rejectsCorruptStateWithoutOverwritingRecoveryData() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path claude = Files.createDirectories(home.resolve(".claude"));
        Path settings = claude.resolve("settings.json");
        String original = "{\"hooks\":{\"Stop\":[{\"type\":\"command\",\"command\":\"echo done\"}]}}";
        Files.writeString(settings, original, StandardCharsets.UTF_8);
        Path state = new HookToggleStateStore(home, claude).getStateFile();
        HookLocalStorage.prepare(home, state.getParent());
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
    public void togglesCodexConfigHookWithoutReformattingConfig() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path config = Files.createDirectories(home.resolve(".codex")).resolve("config.toml");
        Files.writeString(config, """
                # preserve comment
                [features]
                hooks = true

                [[hooks.PreToolUse]]
                matcher = "Bash"
                hooks = [{ type = "command", command = "python guard.py" }]

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

    @Test
    public void projectHooksJsonTogglesOnlyUserStateAndKeepsReferencedScripts() throws Exception {
        Path home = temporaryFolder.newFolder("native-home").toPath();
        Path project = temporaryFolder.newFolder("native-project").toPath();
        Path hooks = Files.createDirectories(project.resolve(".codex")).resolve("hooks.json");
        String declaration = "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"echo project\"}]}]}}\r\n";
        Files.writeString(hooks, declaration);
        Path script = Files.createDirectories(home.resolve(".codex/hooks")).resolve("referenced.sh");
        Files.writeString(script, "echo keep reference\n");
        HookCatalogService catalog = new HookCatalogService(home);
        JsonArray items = catalog.scan(project.toString()).getAsJsonArray("items");
        assertEquals(1, items.size());
        JsonObject item = items.get(0).getAsJsonObject();
        assertEquals("missing", item.get("nativeStateRevision").getAsString());

        JsonObject result = new HookToggleService(home).toggle(project.toString(), request(item, false));

        assertTrue(result.toString(), result.get("success").getAsBoolean());
        Path userConfig = home.resolve(".codex/config.toml");
        assertFalse(org.tomlj.Toml.parse(Files.readString(userConfig)).getBoolean(
                java.util.List.of("hooks", "state", item.get("managedKey").getAsString(), "enabled")));
        assertEquals(declaration, Files.readString(hooks));
        assertEquals("echo keep reference\n", Files.readString(script));
        assertFalse(catalog.scan(project.toString()).getAsJsonArray("items").get(0).getAsJsonObject().get("enabled").getAsBoolean());
        assertFalse(Files.exists(project.resolve(".codex/.ccgui-hooks-state.json")));
    }

    @Test
    public void linkedCodexHomeUsesThePhysicalNativeStateKey() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path physical = Files.createDirectories(home.resolve("physical-codex"));
        Path alias = home.resolve("codex-link");
        Files.createSymbolicLink(alias, physical);
        Path declaration = physical.resolve("hooks.json");
        String original = "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"echo fixture\"}]}]}}";
        Files.writeString(declaration, original);
        HookCatalogService catalog = new HookCatalogService(home, alias);
        JsonObject item = catalog.scan(null).getAsJsonArray("items").get(0).getAsJsonObject();
        String expected = declaration.toRealPath() + ":stop:0:0";
        assertEquals(expected, item.get("managedKey").getAsString());
        JsonObject result = new HookToggleService(home, alias).toggle(null, request(item, false));
        assertTrue(result.toString(), result.get("success").getAsBoolean());
        assertFalse(org.tomlj.Toml.parse(Files.readString(physical.resolve("config.toml"))).getBoolean(
                java.util.List.of("hooks", "state", expected, "enabled")));
        assertEquals(original, Files.readString(declaration));
    }

    @Test
    public void nativeToggleRejectsAChangedUserPreferenceBaseline() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path config = Files.createDirectories(home.resolve(".codex")).resolve("config.toml");
        String declaration = "[[hooks.Stop]]\nhooks=[{type=\"command\",command=\"echo ready\"}]\n";
        Files.writeString(config, declaration);
        JsonObject item = new HookCatalogService(home).scan(null).getAsJsonArray("items").get(0).getAsJsonObject();
        Files.writeString(config, declaration + "\n[features]\nhooks=false\n");
        String changed = Files.readString(config);

        JsonObject result = new HookToggleService(home).toggle(null, request(item, false));

        assertFalse(result.get("success").getAsBoolean());
        assertEquals("HOOK_REVISION_CONFLICT", result.get("errorCode").getAsString());
        assertEquals(changed, Files.readString(config));
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
        if (item.has("nativeStateRevision")) {
            request.addProperty("nativeStateRevision", item.get("nativeStateRevision").getAsString());
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

package com.github.claudecodegui.hooks;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/** Tests the read-only hook discovery contract and preview redaction. */
public class HookCatalogServiceTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void scanDiscoversClaudeAndScriptHooksWithoutExposingSecrets() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path project = temporaryFolder.newFolder("project").toPath();
        Path claudeDirectory = Files.createDirectories(home.resolve(".claude"));
        Files.writeString(claudeDirectory.resolve("settings.local.json"), "{}", StandardCharsets.UTF_8);
        Files.writeString(claudeDirectory.resolve("settings.json"), """
                {
                  "hooks": {
                    "PreToolUse": [{
                      "matcher": "Bash",
                      "hooks": [{
                        "type": "command",
                        "command": "echo TOKEN=super-secret",
                        "enabled": false,
                        "custom": {"mode": "safe", "apiKey": "extension-secret"}
                      }]
                    }]
                  }
                }
                """, StandardCharsets.UTF_8);

        Path codemossHooks = Files.createDirectories(home.resolve(".codemoss").resolve("hooks"));
        Files.writeString(codemossHooks.resolve("before.sh"), "#!/bin/sh\nAPI_KEY=script-secret\necho ready\n",
                StandardCharsets.UTF_8);
        Files.createDirectories(codemossHooks.resolve("__pycache__"));
        Files.write(codemossHooks.resolve("__pycache__").resolve("guard.cpython-311.pyc"), new byte[]{0, 1, 2});
        Files.createDirectories(home.resolve(".codex"));
        Files.writeString(home.resolve(".codex").resolve("config.toml"), """
                [features]
                hooks = true

                [[hooks.pre_tool_use]]
                matcher = "Bash"
                enabled = true
                hooks = [{ type = "command", command = "python", args = ["guard.py"] }]
                """, StandardCharsets.UTF_8);
        Files.createDirectories(project.resolve(".claude"));
        Files.writeString(project.resolve(".claude").resolve("settings.local.json"), "not-json",
                StandardCharsets.UTF_8);

        JsonObject catalog = new HookCatalogService(home).scan(project.toString());

        assertFalse(catalog.get("readOnly").getAsBoolean());
        JsonArray items = catalog.getAsJsonArray("items");
        assertEquals(3, items.size());

        JsonObject claudeItem = findItem(items, "claude");
        assertNotNull(claudeItem);
        assertEquals("PreToolUse", claudeItem.get("event").getAsString());
        assertEquals("Bash", claudeItem.get("matcher").getAsString());
        assertEquals("CLAUDE_INDIVIDUAL_TOGGLE_UNSUPPORTED",
                claudeItem.get("toggleReason").getAsString());
        assertFalse(claudeItem.get("command").getAsString().contains("super-secret"));
        assertFalse(claudeItem.get("rawPreview").getAsString().contains("super-secret"));
        assertTrue(claudeItem.get("lastModified").getAsLong() > 0);
        JsonObject customFields = claudeItem.getAsJsonObject("extensions").getAsJsonObject("custom");
        assertEquals("safe", customFields.get("mode").getAsString());
        assertEquals("<redacted>", customFields.get("apiKey").getAsString());
        assertFalse(claudeItem.getAsJsonObject("extensions").get("enabled").getAsBoolean());
        assertTrue(claudeItem.get("enabled").getAsBoolean());

        JsonObject scriptItem = findItem(items, "codemoss");
        assertNotNull(scriptItem);
        assertEquals("before.sh", scriptItem.get("event").getAsString());
        assertFalse(scriptItem.get("rawPreview").getAsString().contains("script-secret"));
        assertTrue(scriptItem.get("rawPreview").getAsString().contains("<redacted>"));

        JsonObject codexItem = findItem(items, "codex");
        assertNotNull(codexItem);
        assertEquals("pre_tool_use", codexItem.get("event").getAsString());
        assertEquals("Bash", codexItem.get("matcher").getAsString());
        assertEquals("python guard.py", codexItem.get("command").getAsString());
        assertTrue(codexItem.get("enabled").getAsBoolean());
        assertTrue(codexItem.get("toggleSupported").getAsBoolean());
        assertFalse(codexItem.get("managedToggleSupported").getAsBoolean());
        assertEquals("native", codexItem.get("toggleMode").getAsString());

        JsonObject codexSource = findSource(catalog.getAsJsonArray("sources"), "codex", "config-toml");
        assertNotNull(codexSource);
        assertTrue(codexSource.getAsJsonArray("validationIssues").isEmpty());

        JsonObject malformedSource = findSource(catalog.getAsJsonArray("sources"), "claude", "PROJECT_LOCAL",
                "settings-json");
        assertNotNull(malformedSource);
        assertTrue(malformedSource.getAsJsonArray("validationIssues").size() >= 1);

        JsonObject globalLocalSource = findSource(catalog.getAsJsonArray("sources"), "claude", "GLOBAL_LOCAL",
                "settings-json");
        assertNotNull(globalLocalSource);
        assertFalse(globalLocalSource.get("readOnly").getAsBoolean());
        assertTrue(globalLocalSource.get("lastModified").getAsLong() > 0);

        JsonObject codemossSource = findSource(catalog.getAsJsonArray("sources"), "codemoss", "GLOBAL",
                "hook-directory");
        assertNotNull(codemossSource);
        assertFalse(codemossSource.get("readOnly").getAsBoolean());

        JsonObject codexConfigSource = findSource(catalog.getAsJsonArray("sources"), "codex", "GLOBAL",
                "config-toml");
        assertNotNull(codexConfigSource);
        assertFalse(codexConfigSource.get("readOnly").getAsBoolean());

        JsonArray capabilities = catalog.getAsJsonArray("capabilities");
        assertEquals(4, capabilities.size());
        JsonObject claudeCapability = findCapability(capabilities, "claude", "settings-json");
        assertNotNull(claudeCapability);
        assertTrue(claudeCapability.get("editSupported").getAsBoolean());
        assertFalse(claudeCapability.get("toggleSupported").getAsBoolean());
        assertEquals("UNVERIFIED", claudeCapability.get("versionStatus").getAsString());
        assertFalse(claudeCapability.has("sourceControlSupported"));
        assertFalse(claudeCapability.has("sourceControlMode"));

        JsonObject codexTomlCapability = findCapability(capabilities, "codex", "config-toml");
        assertNotNull(codexTomlCapability);
        assertTrue(codexTomlCapability.get("editSupported").getAsBoolean());
        assertTrue(codexTomlCapability.get("toggleSupported").getAsBoolean());
        assertFalse(codexTomlCapability.get("managedToggleSupported").getAsBoolean());
        assertEquals("VERIFIED", codexTomlCapability.get("versionStatus").getAsString());
        assertFalse(codexTomlCapability.has("sourceControlSupported"));
        assertEquals("CODEX_CONFIG_HOOKS_SUPPORTED",
                codexTomlCapability.get("reasonCode").getAsString());
    }

    private static JsonObject findItem(JsonArray items, String provider) {
        for (var element : items) {
            JsonObject item = element.getAsJsonObject();
            if (provider.equals(item.get("provider").getAsString())) {
                return item;
            }
        }
        return null;
    }

    private static JsonObject findSource(JsonArray sources, String provider, String format) {
        return findSource(sources, provider, null, format);
    }

    private static JsonObject findSource(JsonArray sources, String provider, String scope, String format) {
        for (var element : sources) {
            JsonObject source = element.getAsJsonObject();
            if (provider.equals(source.get("provider").getAsString())
                    && (scope == null || scope.equals(source.get("scope").getAsString()))
                    && format.equals(source.get("format").getAsString())) {
                return source;
            }
        }
        return null;
    }

    private static JsonObject findCapability(JsonArray capabilities, String provider, String format) {
        for (var element : capabilities) {
            JsonObject capability = element.getAsJsonObject();
            if (provider.equals(capability.get("provider").getAsString())
                    && format.equals(capability.get("format").getAsString())) {
                return capability;
            }
        }
        return null;
    }
}

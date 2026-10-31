package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.SafeJsonFileOps;
import com.google.gson.GsonBuilder;
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
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.List;

import static org.junit.Assert.*;

public class ProviderBackupServiceTest {
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
    public void ignoresIdentityDisplayMetadataAndJsonKeyOrder() throws Exception {
        JsonObject existing = claude("same-id", "key-one");
        JsonObject config = config("claude", existing);
        JsonObject incoming = JsonParser.parseString(existing.toString()).getAsJsonObject();
        incoming.addProperty("id", "other-id");
        incoming.addProperty("name", "renamed");
        incoming.addProperty("remark", "a note");
        incoming.addProperty("source", "cc-switch");
        incoming.addProperty("isActive", true);
        incoming.addProperty("createdAt", 999);
        incoming.add("settingsConfig", JsonParser.parseString(
                "{\"env\":{\"ANTHROPIC_BASE_URL\":\"https://example.test\",\"ANTHROPIC_AUTH_TOKEN\":\"key-one\"}}"));
        ProviderBackupService.MergeResult result = ProviderBackupService.merge(config, "claude", payload(incoming));
        assertEquals(0, result.imported());
        assertEquals(1, result.skipped());
        assertEquals(config, result.config());
    }

    @Test
    public void sameIdWithDifferentContentAddsNewIdWithoutChangingExistingOrActiveProvider() throws Exception {
        JsonObject config = config("claude", claude("same-id", "key-one"));
        JsonObject original = config.deepCopy();
        JsonObject incoming = claude("same-id", "key-two");
        incoming.addProperty("source", "cc-switch");
        ProviderBackupService.MergeResult result = ProviderBackupService.merge(config, "claude", payload(incoming, incoming));
        assertEquals(original, config);
        assertEquals(1, result.imported());
        assertEquals(1, result.skipped());
        JsonObject section = result.config().getAsJsonObject("claude");
        assertEquals("same-id", section.get("current").getAsString());
        assertEquals(original.get("codex"), result.config().get("codex"));
        assertEquals(original.getAsJsonObject("claude").get("providerOrder"), section.get("providerOrder"));
        JsonObject stored = section.getAsJsonObject("providers");
        assertEquals(2, stored.size());
        assertEquals(claude("same-id", "key-one"), stored.get("same-id"));
        JsonObject added = stored.entrySet().stream().filter(e -> !e.getKey().equals("same-id")).findFirst().orElseThrow().getValue().getAsJsonObject();
        assertFalse(added.has("source"));
        assertFalse(added.has("isActive"));
        assertNotEquals("same-id", added.get("id").getAsString());
        assertEquals(0, ProviderBackupService.merge(result.config(), "claude", payload(incoming)).imported());
    }

    @Test
    public void differentModelsAndEnvironmentAreNotDeduplicated() throws Exception {
        JsonObject config = config("claude", claude("a", "key"));
        JsonObject model = claude("a", "key");
        model.getAsJsonObject("settingsConfig").getAsJsonObject("env").addProperty("ANTHROPIC_MODEL", "custom-model");
        assertEquals(1, ProviderBackupService.merge(config, "claude", payload(model)).imported());
        JsonObject pricing = claude("a", "key");
        pricing.add("customModels", JsonParser.parseString("[{\"id\":\"custom-model\",\"label\":\"Custom\",\"pricing\":{\"inputCostPer1M\":1}}]"));
        assertEquals(1, ProviderBackupService.merge(config, "claude", payload(pricing)).imported());
    }

    @Test
    public void codexComparesParsedTomlAuthAndOrderIndependentEnvironment() throws Exception {
        JsonObject existing = codex("a", "model = 'm'\nmodel_provider = 'custom'\n", "{\"OPENAI_API_KEY\":\"key\",\"extra\":true}");
        existing.add("messageEnvVars", JsonParser.parseString("[{\"key\":\"A\",\"value\":\"1\"},{\"key\":\"B\",\"value\":\"2\"}]"));
        JsonObject incoming = codex("b", "# comment\nmodel_provider=\"custom\"\nmodel=\"m\"\n", "{\"extra\":true,\"OPENAI_API_KEY\":\"key\"}");
        incoming.add("messageEnvVars", JsonParser.parseString("[{\"key\":\"B\",\"value\":\"2\"},{\"key\":\"A\",\"value\":\"1\"}]"));
        JsonObject config = config("codex", existing);
        assertEquals(0, ProviderBackupService.merge(config, "codex", payload(incoming)).imported());
        incoming.addProperty("authJson", "{\"OPENAI_API_KEY\":\"different-key\",\"extra\":true}");
        assertEquals(1, ProviderBackupService.merge(config, "codex", payload(incoming)).imported());
    }

    @Test
    public void codexExportsOptionalFieldsWithoutChangingTheirStoredValues() throws Exception {
        for (String field : List.of("authJson", "configToml")) {
            for (String value : List.of("", " \n\t", "missing", "null")) {
                JsonObject provider = codex("a", "model = 'test-model'\n", "{}");
                if (value.equals("missing")) provider.remove(field);
                else if (value.equals("null")) provider.add(field, JsonNull.INSTANCE);
                else provider.addProperty(field, value);
                JsonObject config = config("codex", provider);
                JsonObject original = config.deepCopy();
                JsonObject exported = ProviderBackupService.exportPayload(config, "codex").payload();
                JsonObject portable = exported.getAsJsonArray("providers").get(0).getAsJsonObject();
                assertEquals(original, config);
                if (value.equals("missing") || value.equals("null")) assertFalse(portable.has(field));
                else assertEquals(value, portable.get(field).getAsString());
                var imported = ProviderBackupService.merge(new JsonObject(), "codex", exported);
                assertEquals(1, imported.imported());
                assertEquals(0, ProviderBackupService.merge(imported.config(), "codex", exported).imported());
            }
        }
    }

    @Test
    public void codexEmptyAuthSupportsEncryptedBackupRoundTrip() throws Exception {
        JsonObject config = config("codex", codex("a", "model = 'test-model'\n", ""));
        JsonObject exported = ProviderBackupService.exportPayload(config, "codex").payload();
        char[] password = "test-only-password".toCharArray();
        byte[] bytes = ProviderBackupCodec.encode("codex", exported, password);
        JsonObject decoded = ProviderBackupCodec.decode(bytes, "codex", password);
        assertEquals(exported, decoded);
        assertEquals(1, ProviderBackupService.merge(new JsonObject(), "codex", decoded).imported());
    }

    @Test
    public void codexMissingAuthIsNotTheSameAsAnExplicitEmptyObject() throws Exception {
        JsonObject missing = codex("a", "", "");
        JsonObject whitespace = codex("b", "", " \n");
        JsonObject absent = codex("c", "", "{}");
        absent.remove("authJson");
        JsonObject explicitObject = codex("d", "", "{}");
        JsonObject config = config("codex", missing);
        assertEquals(0, ProviderBackupService.merge(config, "codex", payload(whitespace, absent)).imported());
        assertEquals(1, ProviderBackupService.merge(config, "codex", payload(explicitObject)).imported());
    }

    @Test
    public void codexOptionalFieldsStillRejectNonStringAndMalformedValues() {
        for (String field : List.of("configToml", "authJson")) {
            for (JsonElement invalid : List.of(new JsonObject(), new JsonArray(), new JsonPrimitive(true), new JsonPrimitive(42))) {
                JsonObject provider = codex("a", "", "{}");
                provider.add(field, invalid);
                var failure = assertThrows(ProviderBackupCodec.BackupException.class,
                        () -> ProviderBackupService.exportPayload(config("codex", provider), "codex"));
                assertEquals("invalidFile", failure.getMessage());
                assertEquals(field, failure.details().get("field").getAsString());
                assertThrows(ProviderBackupCodec.BackupException.class,
                        () -> ProviderBackupService.merge(new JsonObject(), "codex", payload(provider)));
            }
        }
        for (String auth : List.of("[]", "null", "true", "42", "{\"OPENAI_API_KEY\":secret-value}")) {
            JsonObject provider = codex("a", "", auth);
            var failure = assertThrows(ProviderBackupCodec.BackupException.class,
                    () -> ProviderBackupService.exportPayload(config("codex", provider), "codex"));
            assertEquals("authJson", failure.details().get("field").getAsString());
            assertFalse(failure.toString().contains("secret-value"));
        }
    }

    @Test
    public void exportSkipsInvalidSavedProvidersAndReportsOnlyTheirPositions() throws Exception {
        for (String field : List.of("configToml", "authJson", "customModels", "messageEnvVars", "mcpEnvVars", "name", "remark")) {
            JsonObject good = codex("a", "", "{}");
            JsonObject bad = invalidCodex(field);
            JsonObject config = config("codex", good);
            JsonObject section = config.getAsJsonObject("codex");
            section.getAsJsonObject("providers").add("private-id", bad);
            section.getAsJsonObject("providers").add("__codex_cli_login__", new JsonObject());
            section.getAsJsonObject("providers").add("b", codex("b", "model = 'b'\n", "{}"));
            section.add("providerOrder", JsonParser.parseString("[\"__codex_cli_login__\",\"a\",\"private-id\",\"b\"]"));
            JsonObject original = config.deepCopy();
            var result = ProviderBackupService.exportPayload(config, "codex");
            assertEquals(2, result.payload().getAsJsonArray("providers").size());
            assertEquals(List.of(2), result.skippedProviders());
            assertFalse(result.payload().toString().contains("private-"));
            assertEquals(original, config);
        }
    }

    @Test
    public void exportFailsWithTheFirstInvalidPositionWhenNothingValidRemains() {
        for (String field : List.of("configToml", "authJson", "customModels", "messageEnvVars", "mcpEnvVars", "name", "remark")) {
            JsonObject config = config("codex", invalidCodex(field));
            JsonObject section = config.getAsJsonObject("codex");
            section.getAsJsonObject("providers").add("__codex_cli_login__", new JsonObject());
            section.getAsJsonObject("providers").add("second", invalidCodex("name"));
            section.add("providerOrder", JsonParser.parseString("[\"__codex_cli_login__\",\"private-id\",\"second\"]"));
            JsonObject original = config.deepCopy();
            var failure = assertThrows(ProviderBackupCodec.BackupException.class,
                    () -> ProviderBackupService.exportPayload(config, "codex"));
            assertEquals("invalidFile", failure.getMessage());
            assertEquals(JsonParser.parseString("{\"providerIndex\":1,\"field\":\"" + field + "\"}"), failure.details());
            assertFalse(failure.toString().contains("private-"));
            assertNull(failure.getCause());
            assertEquals(original, config);
        }
    }

    @Test
    public void exportCountsNonObjectEntriesAsSkippedPositions() throws Exception {
        JsonObject config = config("claude", claude("a", "key"));
        JsonObject section = config.getAsJsonObject("claude");
        section.getAsJsonObject("providers").add("broken", new JsonPrimitive("private-value"));
        section.getAsJsonObject("providers").add("b", claude("b", "other-key"));
        section.add("providerOrder", JsonParser.parseString("[\"broken\",\"a\",\"b\"]"));
        var result = ProviderBackupService.exportPayload(config, "claude");
        assertEquals(2, result.payload().getAsJsonArray("providers").size());
        assertEquals(List.of(1), result.skippedProviders());
        assertFalse(result.payload().toString().contains("private-value"));
    }

    @Test
    public void protectedEnvironmentNamesMatchTheProviderFormList() throws Exception {
        String source = Files.readString(Path.of("webview/src/types/provider.ts"));
        java.util.regex.Matcher block = java.util.regex.Pattern
                .compile("CODEX_PROTECTED_ENV_KEYS[^=]*=\\s*new Set\\(\\[(.*?)\\]\\)", java.util.regex.Pattern.DOTALL)
                .matcher(source);
        assertTrue("CODEX_PROTECTED_ENV_KEYS not found in provider.ts", block.find());
        java.util.Set<String> formKeys = new java.util.HashSet<>();
        java.util.regex.Matcher name = java.util.regex.Pattern.compile("'([A-Z0-9_]+)'").matcher(block.group(1));
        while (name.find()) formKeys.add(name.group(1));
        assertEquals(formKeys, ProviderBackupService.PROTECTED_ENV_KEYS);
    }

    @Test
    public void protectedEnvironmentNamesAreRejectedLikeTheProviderForm() {
        for (String field : List.of("messageEnvVars", "mcpEnvVars")) {
            for (String key : List.of("PATH", "codex_home", " HOME ")) {
                JsonObject provider = codex("a", "", "{}");
                provider.add(field, JsonParser.parseString("[{\"key\":\"" + key + "\",\"value\":\"x\"}]"));
                var imported = assertThrows(ProviderBackupCodec.BackupException.class,
                        () -> ProviderBackupService.merge(new JsonObject(), "codex", payload(provider)));
                assertEquals(field, imported.details().get("field").getAsString());
                var exported = assertThrows(ProviderBackupCodec.BackupException.class,
                        () -> ProviderBackupService.exportPayload(config("codex", provider), "codex"));
                assertEquals(field, exported.details().get("field").getAsString());
            }
        }
    }

    @Test
    public void exportValidationPreservesSizeLimitsAndClaudeValidation() {
        JsonObject largeToml = codex("a", "#" + "x".repeat(256 * 1024), "");
        var tooLarge = assertThrows(ProviderBackupCodec.BackupException.class,
                () -> ProviderBackupService.exportPayload(config("codex", largeToml), "codex"));
        assertEquals("tooLarge", tooLarge.getMessage());
        assertEquals("configToml", tooLarge.details().get("field").getAsString());
        JsonObject claude = claude("a", "test-secret");
        claude.getAsJsonObject("settingsConfig").add("env", new JsonArray());
        var invalidClaude = assertThrows(ProviderBackupCodec.BackupException.class,
                () -> ProviderBackupService.exportPayload(config("claude", claude), "claude"));
        assertEquals("settingsConfig", invalidClaude.details().get("field").getAsString());
    }

    @Test
    public void invalidCodexTomlAuthAndEnvironmentRejectTheEntireBatch() {
        JsonObject invalidToml = codex("a", "model = [", "{}");
        JsonObject deepToml = codex("a", "value = " + "[".repeat(10000) + "0" + "]".repeat(10000), "{}");
        JsonObject invalidAuth = codex("a", "", "[]");
        JsonObject invalidEnv = codex("a", "", "{}");
        invalidEnv.add("messageEnvVars", JsonParser.parseString("[{\"key\":\"A\",\"value\":\"1\"},{\"key\":\"a\",\"value\":\"2\"}]"));
        for (JsonObject invalid : List.of(invalidToml, deepToml, invalidAuth, invalidEnv)) {
            assertThrows(ProviderBackupCodec.BackupException.class,
                    () -> ProviderBackupService.merge(new JsonObject(), "codex", payload(invalid)));
        }
    }

    @Test
    public void malformedEntryRejectsWholeImportAndLeavesFileUnchanged() throws Exception {
        Path path = configPath;
        String original = config("claude", claude("a", "one")).toString();
        Files.writeString(path, original);
        JsonObject invalid = new JsonObject();
        invalid.addProperty("name", "invalid");
        CodemossSettingsService service = new CodemossSettingsService();
        assertThrows(ProviderBackupCodec.BackupException.class, () -> service.importProviderBackup(
                "claude", payload(claude("b", "two"), invalid)));
        assertEquals(original, Files.readString(path));
        Files.writeString(path, "broken local config");
        assertThrows(java.io.IOException.class, () -> service.importProviderBackup("claude", payload(claude("c", "three"))));
        assertEquals("broken local config", Files.readString(path));
    }

    @Test
    public void importUsesTheStandardPrettyPrintedWriteAndRefreshesTheUsualBackup() throws Exception {
        String before = config("claude", claude("a", "one")).toString();
        Files.writeString(configPath, before);
        var result = new CodemossSettingsService().importProviderBackup("claude", payload(claude("b", "two")));
        String written = Files.readString(configPath);
        assertEquals(1, result.imported());
        assertEquals(new GsonBuilder().setPrettyPrinting().serializeNulls().create().toJson(result.config()), written);
        assertTrue(written.contains("\n  \""));
        assertEquals(before, Files.readString(configPath.resolveSibling("config.json.bak")));
        assertFalse(Files.exists(SafeJsonFileOps.sibling(configPath, SafeJsonFileOps.BACKUP_SUFFIX)));
    }

    @Test
    public void importIntoAMissingConfigStartsFromTheDefaultConfiguration() throws Exception {
        var result = new CodemossSettingsService().importProviderBackup("codex", payload(codex("a", "model = 'a'\n", "{}")));
        JsonObject stored = JsonParser.parseString(Files.readString(configPath)).getAsJsonObject();
        assertEquals(1, result.imported());
        assertTrue(stored.has("version"));
        assertEquals("", stored.getAsJsonObject("claude").get("current").getAsString());
        assertEquals("", stored.getAsJsonObject("codex").get("current").getAsString());
        assertEquals(1, stored.getAsJsonObject("codex").getAsJsonObject("providers").size());
    }

    @Test
    public void exportsOnlySavedEntriesAndDoesNotCarryActivityOrSourceLinkage() throws Exception {
        JsonObject config = config("claude", claude("a", "key"));
        JsonObject providers = config.getAsJsonObject("claude").getAsJsonObject("providers");
        providers.add("__cli_login__", claude("__cli_login__", "never-export"));
        JsonObject existing = providers.getAsJsonObject("a");
        existing.addProperty("source", "cc-switch");
        existing.addProperty("isActive", true);
        JsonArray exported = ProviderBackupService.exportPayload(config, "claude").payload().getAsJsonArray("providers");
        assertEquals(1, exported.size());
        assertFalse(exported.get(0).getAsJsonObject().has("id"));
        assertFalse(exported.get(0).getAsJsonObject().has("source"));
        assertFalse(exported.get(0).getAsJsonObject().has("isActive"));
        assertFalse(exported.toString().contains("never-export"));
    }

    @Test
    public void concurrentImportsAreSerializedAndDuplicateOnlyImportDoesNotRewrite() throws Exception {
        Path path = configPath;
        Files.writeString(path, config("claude", claude("a", "one")).toString());
        CodemossSettingsService service = new CodemossSettingsService();
        var executor = Executors.newFixedThreadPool(2);
        try {
            Callable<ProviderBackupService.MergeResult> task = () -> service.importProviderBackup("claude", payload(claude("b", "two")));
            var results = executor.invokeAll(List.of(task, task));
            assertEquals(1, results.get(0).get().imported() + results.get(1).get().imported());
            assertEquals(2, JsonParser.parseString(Files.readString(path)).getAsJsonObject().getAsJsonObject("claude").getAsJsonObject("providers").size());
            var modified = Files.getLastModifiedTime(path);
            String before = Files.readString(path);
            assertEquals(0, task.call().imported());
            assertEquals(modified, Files.getLastModifiedTime(path));
            assertEquals(before, Files.readString(path));
        } finally {
            executor.shutdownNow();
        }
    }

    private static JsonObject payload(JsonObject... providers) {
        JsonArray array = new JsonArray();
        for (JsonObject provider : providers) array.add(provider);
        JsonObject payload = new JsonObject();
        payload.add("providers", array);
        return payload;
    }

    @Test
    public void importPreservesNullsInExistingAndUnrelatedConfigurationOnDisk() throws Exception {
        Path path = configPath;
        JsonObject original = config("claude", claude("a", "one"));
        original.add("unrelated", JsonParser.parseString("{\"keep\":null,\"nested\":{\"keep\":null},\"array\":[null]}"));
        original.getAsJsonObject("claude").getAsJsonObject("providers").getAsJsonObject("a")
                .getAsJsonObject("settingsConfig").add("model", JsonNull.INSTANCE);
        Files.writeString(path, original.toString());
        var result = new CodemossSettingsService().importProviderBackup("claude", payload(claude("b", "two")));
        JsonObject stored = JsonParser.parseString(Files.readString(path)).getAsJsonObject();
        assertEquals(1, result.imported());
        assertEquals(result.config(), stored);
        assertEquals(original.get("unrelated"), stored.get("unrelated"));
        assertEquals(original.getAsJsonObject("claude").getAsJsonObject("providers").get("a"),
                stored.getAsJsonObject("claude").getAsJsonObject("providers").get("a"));
    }

    @Test
    public void importRestrictsExistingConfigWithBroadPosixPermissions() throws Exception {
        Path path = Files.createFile(configPath);
        org.junit.Assume.assumeTrue("POSIX-only check", Files.getFileStore(path).supportsFileAttributeView("posix"));
        Files.writeString(path, "{}");
        Files.setPosixFilePermissions(path, java.nio.file.attribute.PosixFilePermissions.fromString("rw-r--r--"));
        var result = new CodemossSettingsService().importProviderBackup("claude", payload(claude("a", "synthetic-key")));
        assertEquals(1, result.imported());
        assertEquals(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"), Files.getPosixFilePermissions(path));
        assertEquals(result.config(), JsonParser.parseString(Files.readString(path)));
    }

    @Test
    public void exportRejectsOverDeepStoredFieldsBeforeCopying() {
        JsonObject provider = claude("a", "synthetic-key");
        JsonObject settings = provider.getAsJsonObject("settingsConfig");
        for (int i = 0; i < 10_000; i++) {
            JsonObject child = new JsonObject();
            settings.add("nested", child);
            settings = child;
        }
        var failure = assertThrows(ProviderBackupCodec.BackupException.class,
                () -> ProviderBackupService.exportPayload(config("claude", provider), "claude"));
        assertEquals("invalidFile", failure.getMessage());
        assertEquals("settingsConfig", failure.details().get("field").getAsString());
    }

    @Test
    public void providerBackupsAtTheDepthBoundaryEitherRoundTripOrFailDuringEncode() throws Exception {
        for (int layers : new int[]{59, 60, 61}) {
            JsonObject settings = new JsonObject();
            settings.addProperty("leaf", "synthetic");
            for (int i = 0; i < layers; i++) {
                JsonObject parent = new JsonObject();
                parent.add("nested", settings);
                settings = parent;
            }
            JsonObject provider = claude("a", "synthetic-key");
            provider.add("settingsConfig", settings);
            JsonObject original = config("claude", provider);
            JsonObject exported = ProviderBackupService.exportPayload(original, "claude").payload();
            for (char[] password : List.of(new char[0], "test-password".toCharArray())) {
                // Payload adds an object, a providers array and a provider object;
                // plaintext adds the envelope too. The leaf settings object also counts.
                int limit = password.length == 0 ? 59 : 60;
                if (layers > limit) {
                    var failure = assertThrows(ProviderBackupCodec.BackupException.class,
                            () -> ProviderBackupCodec.encode("claude", exported, password));
                    assertEquals("invalidFile", failure.getMessage());
                } else {
                    byte[] bytes = ProviderBackupCodec.encode("claude", exported, password);
                    JsonObject decoded = ProviderBackupCodec.decode(bytes, "claude", password);
                    assertEquals(exported, decoded);
                    assertEquals(0, ProviderBackupService.merge(original, "claude", decoded).imported());
                    assertEquals(1, ProviderBackupService.merge(new JsonObject(), "claude", decoded).imported());
                }
            }
        }
    }

    @Test
    public void exportedNullConfigurationIsStillADuplicateWhenImportedBack() throws Exception {
        JsonObject provider = claude("a", "one");
        provider.getAsJsonObject("settingsConfig").add("model", JsonNull.INSTANCE);
        JsonObject config = config("claude", provider);
        JsonObject exported = ProviderBackupService.exportPayload(config, "claude").payload();
        byte[] bytes = ProviderBackupCodec.encode("claude", exported, "test-password".toCharArray());
        JsonObject decoded = ProviderBackupCodec.decode(bytes, "claude", "test-password".toCharArray());
        assertEquals(0, ProviderBackupService.merge(config, "claude", decoded).imported());
    }

    @Test
    public void normalizesLegacyEnvironmentNamesButPreservesValuesAndOriginalConfig() throws Exception {
        for (String field : List.of("messageEnvVars", "mcpEnvVars")) {
            JsonObject provider = codex("a", "", "{}");
            provider.add(field, JsonParser.parseString("[{\"key\":\" HTTPS_PROXY \",\"value\":\"  unchanged value  \"}]"));
            JsonObject config = config("codex", provider);
            JsonObject original = config.deepCopy();
            JsonObject exported = ProviderBackupService.exportPayload(config, "codex").payload();
            JsonObject entry = exported.getAsJsonArray("providers").get(0).getAsJsonObject().getAsJsonArray(field).get(0).getAsJsonObject();
            assertEquals("HTTPS_PROXY", entry.get("key").getAsString());
            assertEquals("  unchanged value  ", entry.get("value").getAsString());
            assertEquals(original, config);
            assertEquals(0, ProviderBackupService.merge(config, "codex", exported).imported());
            var imported = ProviderBackupService.merge(new JsonObject(), "codex", payload(provider));
            JsonObject saved = imported.config().getAsJsonObject("codex").getAsJsonObject("providers").asMap().values()
                    .iterator().next().getAsJsonObject();
            assertEquals("HTTPS_PROXY", saved.getAsJsonArray(field).get(0).getAsJsonObject().get("key").getAsString());
        }
    }

    @Test
    public void rejectsEnvironmentNamesThatCollideAfterTrimming() {
        JsonObject provider = codex("a", "", "{}");
        provider.add("messageEnvVars", JsonParser.parseString("[{\"key\":\" A \",\"value\":\"1\"},{\"key\":\"a\",\"value\":\"2\"}]"));
        assertThrows(ProviderBackupCodec.BackupException.class,
                () -> ProviderBackupService.exportPayload(config("codex", provider), "codex"));
    }

    private static JsonObject config(String engine, JsonObject provider) {
        JsonObject config = new JsonObject();
        JsonObject section = new JsonObject();
        JsonObject providers = new JsonObject();
        String id = provider.get("id").getAsString();
        providers.add(id, provider);
        section.add("providers", providers);
        section.addProperty("current", id);
        section.addProperty("cliLoginAuthorized", true);
        JsonArray order = new JsonArray();
        order.add(id);
        section.add("providerOrder", order);
        config.add(engine, section);
        config.addProperty("language", "zh");
        if (!engine.equals("codex")) config.add("codex", new JsonObject());
        return config;
    }

    private static JsonObject claude(String id, String key) {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", id);
        provider.addProperty("name", "Provider");
        JsonObject settings = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", key);
        env.addProperty("ANTHROPIC_BASE_URL", "https://example.test");
        settings.add("env", env);
        provider.add("settingsConfig", settings);
        return provider;
    }

    private static JsonObject invalidCodex(String field) {
        JsonObject bad = codex("private-id", "", "{}");
        bad.addProperty("name", "private-name");
        if (field.equals("configToml") || field.equals("authJson")) bad.addProperty(field, "private-secret = [");
        else bad.add(field, JsonParser.parseString("{\"private-secret\":true}"));
        return bad;
    }

    private static JsonObject codex(String id, String toml, String auth) {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", id);
        provider.addProperty("name", "Codex");
        provider.addProperty("configToml", toml);
        provider.addProperty("authJson", auth);
        return provider;
    }
}

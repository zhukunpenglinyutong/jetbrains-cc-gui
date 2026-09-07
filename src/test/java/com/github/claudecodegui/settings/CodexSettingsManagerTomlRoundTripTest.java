package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class CodexSettingsManagerTomlRoundTripTest {

    private String originalHomeDir;
    private boolean homeOverridden;

    @After
    public void tearDown() throws Exception {
        if (homeOverridden) {
            setCachedHomeDirectory(originalHomeDir);
            homeOverridden = false;
        }
    }

    @Test
    public void shouldPreserveQuotedKeysWhenMergingProviderAndMcpConfig() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-toml-quoted-key-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(
                codexDir.resolve("config.toml"),
                "[mcp_servers.codegraph]\ncommand = \"uvx\"\n",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        assertTrue(manager.readConfigToml().get("mcp_servers") instanceof Map);
        JsonObject provider = new JsonObject();
        provider.addProperty("id", "proxy");
        provider.addProperty("configToml", "\"provider.name\" = \"proxy\"\n"
                + "\n"
                + "[model_aliases]\n"
                + "\"gpt-5.4\" = \"vendor/gpt-5.4\"\n");

        manager.transitionProvider(null, provider, false, () -> { });

        String writtenConfig = Files.readString(codexDir.resolve("config.toml"), StandardCharsets.UTF_8);
        assertTrue(writtenConfig.contains("\"provider.name\" = \"proxy\""));
        assertTrue(writtenConfig.contains("\"gpt-5.4\" = \"vendor/gpt-5.4\""));
        assertTrue(writtenConfig.contains("[mcp_servers.codegraph]"));
        assertTrue(writtenConfig.contains("command = \"uvx\""));
    }

    @Test
    public void shouldPreserveExistingSkillConfigWhenProviderOmitsIt() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-toml-skill-config-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(
                codexDir.resolve("config.toml"),
                "[[skills.config]]\npath = \"C:/skills/review/SKILL.md\"\nenabled = false\n",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject provider = new JsonObject();
        provider.addProperty("id", "proxy");
        provider.addProperty("configToml", "model = \"gpt-5\"\n");

        manager.transitionProvider(null, provider, false, () -> { });

        Map<String, Object> writtenConfig = manager.readConfigToml();
        assertEquals("gpt-5", writtenConfig.get("model"));
        assertTrue(writtenConfig.get("skills") instanceof Map);
        @SuppressWarnings("unchecked")
        Map<String, Object> skills = (Map<String, Object>) writtenConfig.get("skills");
        assertTrue(skills.get("config") instanceof List);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> skillConfigs = (List<Map<String, Object>>) skills.get("config");
        assertEquals(1, skillConfigs.size());
        assertEquals("C:/skills/review/SKILL.md", skillConfigs.get(0).get("path"));
        assertEquals(Boolean.FALSE, skillConfigs.get(0).get("enabled"));
    }

    @Test
    public void shouldPreserveBackslashesInTomlLiteralStrings() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-toml-literal-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(
                codexDir.resolve("config.toml"),
                "[literals]\nwindows_path = 'C:\\tools\\codex'\npattern = '\\d+\\s'\n",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        @SuppressWarnings("unchecked")
        Map<String, Object> literals = (Map<String, Object>) manager.readConfigToml().get("literals");

        assertEquals("C:\\tools\\codex", literals.get("windows_path"));
        assertEquals("\\d+\\s", literals.get("pattern"));
    }

    @Test
    public void shouldQuoteNonBareKeysAcrossSerializedStructures() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-toml-serialization-home");
        useTemporaryHomeDirectory(tempHome);

        Map<String, Object> config = new LinkedHashMap<>();
        config.put("top.level", "root");
        Map<String, Object> section = new LinkedHashMap<>();
        section.put("nested.key", "nested");
        config.put("section", section);
        Map<String, Object> tableEntry = new LinkedHashMap<>();
        tableEntry.put("entry.key", "entry");
        List<Map<String, Object>> tableEntries = new ArrayList<>();
        tableEntries.add(tableEntry);
        config.put("items", tableEntries);

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        manager.writeConfigToml(config);

        String writtenConfig = Files.readString(manager.getConfigTomlPath(), StandardCharsets.UTF_8);
        assertTrue(writtenConfig.contains("\"top.level\" = \"root\""));
        assertTrue(writtenConfig.contains("\"nested.key\" = \"nested\""));
        assertTrue(writtenConfig.contains("\"entry.key\" = \"entry\""));
    }

    @Test
    public void shouldReplaceOnlyProviderOwnedValuesAcrossProviderSwitches() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-provider-ownership-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(
                codexDir.resolve("config.toml"),
                "custom_global = \"keep\"\n"
                        + "[mcp_servers.codegraph]\ncommand = \"uvx\"\n"
                        + "[[skills.config]]\npath = \"C:/skills/review/SKILL.md\"\nenabled = false\n",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject providerA = provider(
                "provider-a",
                "model = \"model-a\"\nlegacy_provider_option = true\n"
                        + "[model_providers.a]\nbase_url = \"https://a.example/v1\"\n"
                        + "[vendor_options.skills]\nenabled = true\n"
                        + "[vendor_options.model_providers.inner]\nmode = \"legacy\"\n",
                "{\"OPENAI_API_KEY\":\"a-key\"}"
        );
        JsonObject providerB = provider(
                "provider-b",
                "model = \"model-b\"\n"
                        + "[model_providers.b]\nbase_url = \"https://b.example/v1\"\n",
                "{\"OPENAI_API_KEY\":\"b-key\"}"
        );

        manager.transitionProvider(null, providerA, false, () -> { });
        manager.transitionProvider(providerA, providerB, false, () -> { });

        Map<String, Object> config = manager.readConfigToml();
        assertEquals("keep", config.get("custom_global"));
        assertEquals("model-b", config.get("model"));
        assertFalse(config.containsKey("legacy_provider_option"));
        assertFalse(config.containsKey("vendor_options"));
        assertTrue(config.containsKey("mcp_servers"));
        assertTrue(config.containsKey("skills"));
        @SuppressWarnings("unchecked")
        Map<String, Object> modelProviders = (Map<String, Object>) config.get("model_providers");
        assertFalse(modelProviders.containsKey("a"));
        assertTrue(modelProviders.containsKey("b"));
        assertEquals("b-key", manager.readAuthJson().get("OPENAI_API_KEY").getAsString());
    }

    @Test
    public void shouldRestoreOverwrittenCliValuesWithoutRestoringStaleGlobalConfig() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-provider-baseline-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(
                codexDir.resolve("config.toml"),
                "model = \"cli-model\"\nmodel_reasoning_effort = \"high\"\n"
                        + "[model_providers.proxy]\nbase_url = \"https://original.example/v1\"\n"
                        + "[mcp_servers.original]\ncommand = \"uvx\"\n",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject provider = provider(
                "custom",
                "model = \"custom-model\"\nmodel_reasoning_effort = \"low\"\n"
                        + "[model_providers.proxy]\nbase_url = \"https://custom.example/v1\"\n",
                "{\"OPENAI_API_KEY\":\"custom-key\"}"
        );

        manager.transitionProvider(null, provider, false, () -> { });
        manager.updateConfigToml(config -> {
            @SuppressWarnings("unchecked")
            Map<String, Object> mcpServers = (Map<String, Object>) config.get("mcp_servers");
            Map<String, Object> added = new java.util.LinkedHashMap<>();
            added.put("command", "node");
            mcpServers.put("added-while-managed", added);
            return true;
        });
        CodexSettingsManager restartedManager = new CodexSettingsManager(new Gson());
        restartedManager.transitionProvider(provider, null, true, () -> { });

        Map<String, Object> restored = restartedManager.readConfigToml();
        assertEquals("cli-model", restored.get("model"));
        assertEquals("high", restored.get("model_reasoning_effort"));
        @SuppressWarnings("unchecked")
        Map<String, Object> modelProviders = (Map<String, Object>) restored.get("model_providers");
        @SuppressWarnings("unchecked")
        Map<String, Object> restoredProxy = (Map<String, Object>) modelProviders.get("proxy");
        assertEquals("https://original.example/v1", restoredProxy.get("base_url"));
        @SuppressWarnings("unchecked")
        Map<String, Object> mcpServers = (Map<String, Object>) restored.get("mcp_servers");
        assertTrue(mcpServers.containsKey("original"));
        assertTrue(mcpServers.containsKey("added-while-managed"));
        assertFalse(Files.exists(codexDir.resolve("config.toml.provider_backup")));
    }

    @Test
    public void shouldCaptureEachProvidersBaselineFromTheLatestGlobalConfig() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-provider-latest-baseline-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(codexDir.resolve("config.toml"), "shared_option = 1\n", StandardCharsets.UTF_8);

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject providerA = provider("provider-a", "shared_option = 10\n", "");
        JsonObject providerB = provider("provider-b", "provider_b_option = true\n", "");
        JsonObject providerC = provider("provider-c", "shared_option = 30\n", "");

        manager.transitionProvider(null, providerA, false, () -> { });
        manager.transitionProvider(providerA, providerB, false, () -> { });
        assertEquals(1L, manager.readConfigToml().get("shared_option"));

        manager.updateConfigToml(config -> {
            config.put("shared_option", 2L);
            return true;
        });
        manager.transitionProvider(providerB, providerC, false, () -> { });
        manager.transitionProvider(providerC, null, false, () -> { });

        assertEquals(2L, manager.readConfigToml().get("shared_option"));
    }

    @Test
    public void shouldPreserveUnownedSiblingAddedInsideProviderTable() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-provider-nested-sibling-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject provider = provider("custom", "[provider_options]\nowned = true\n", "");
        manager.transitionProvider(null, provider, false, () -> { });
        manager.updateConfigToml(config -> {
            @SuppressWarnings("unchecked")
            Map<String, Object> options = (Map<String, Object>) config.get("provider_options");
            options.put("global_sibling", "keep");
            return true;
        });

        manager.transitionProvider(provider, null, false, () -> { });

        @SuppressWarnings("unchecked")
        Map<String, Object> options = (Map<String, Object>) manager.readConfigToml().get("provider_options");
        assertFalse(options.containsKey("owned"));
        assertEquals("keep", options.get("global_sibling"));
    }

    @Test
    public void shouldClearProviderAuthWhenNextProviderHasNoAuth() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-provider-empty-auth-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject authenticatedProvider = provider(
                "authenticated",
                "model = \"authenticated-model\"\n",
                "{\"OPENAI_API_KEY\":\"custom-key\"}"
        );
        JsonObject configOnlyProvider = new JsonObject();
        configOnlyProvider.addProperty("id", "config-only");
        configOnlyProvider.addProperty("configToml", "model = \"config-only-model\"\n");

        manager.transitionProvider(null, authenticatedProvider, false, () -> { });
        manager.transitionProvider(authenticatedProvider, configOnlyProvider, false, () -> { });

        assertFalse(Files.exists(codexDir.resolve("auth.json")));
        assertTrue(manager.isProviderApplied(configOnlyProvider));

        Files.writeString(
                codexDir.resolve("auth.json"),
                "{\"OPENAI_API_KEY\":\"stale-key\"}",
                StandardCharsets.UTF_8
        );
        assertFalse(manager.isProviderApplied(configOnlyProvider));
    }

    @Test
    public void shouldRemoveManagedAuthWhenCliBackupDoesNotExist() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-provider-cli-without-backup-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject provider = provider(
                "custom",
                "model = \"custom-model\"\n",
                "{\"OPENAI_API_KEY\":\"custom-key\"}"
        );
        manager.transitionProvider(null, provider, false, () -> { });
        manager.transitionProvider(provider, null, true, () -> { });

        assertFalse(Files.exists(codexDir.resolve("auth.json")));
        assertFalse(Files.exists(codexDir.resolve("auth.json.cli_backup")));
    }

    @Test
    public void shouldRestoreOAuthWhenLeavingManagedModeAndKeepNewerLogin() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-provider-none-oauth-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Path authPath = codexDir.resolve("auth.json");
        Files.writeString(
                authPath,
                "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"oauth-a\"}}",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject provider = provider(
                "custom",
                "model = \"custom-model\"\n",
                "{\"OPENAI_API_KEY\":\"custom-key\"}"
        );
        manager.transitionProvider(null, provider, false, () -> { });
        manager.transitionProvider(provider, null, false, () -> { });

        assertEquals("oauth-a", manager.readAuthJson()
                .getAsJsonObject("tokens").get("access_token").getAsString());
        assertFalse(Files.exists(codexDir.resolve("auth.json.cli_backup")));

        Files.writeString(
                authPath,
                "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"oauth-b\"}}",
                StandardCharsets.UTF_8
        );
        manager.transitionProvider(null, null, true, () -> { });

        assertEquals("oauth-b", manager.readAuthJson()
                .getAsJsonObject("tokens").get("access_token").getAsString());
    }

    @Test
    public void shouldRestoreLocalApiKeyAfterLeavingManagedProvider() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-provider-api-key-backup-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(
                codexDir.resolve("auth.json"),
                "{\"OPENAI_API_KEY\":\"local-key\"}",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject provider = provider(
                "custom",
                "model = \"custom-model\"\n",
                "{\"OPENAI_API_KEY\":\"provider-key\"}"
        );

        manager.transitionProvider(null, provider, false, () -> { });
        assertEquals("provider-key", manager.readAuthJson().get("OPENAI_API_KEY").getAsString());

        manager.transitionProvider(provider, null, true, () -> { });
        assertEquals("local-key", manager.readAuthJson().get("OPENAI_API_KEY").getAsString());
        assertFalse(Files.exists(codexDir.resolve("auth.json.cli_backup")));
    }

    @Test
    public void shouldBackupLegacyLocalAuthOnFirstPostUpgradeTransition() throws Exception {
        // Legacy state: provider A (config-only, no authJson) was applied by old
        // code which never took an auth backup, so auth.json still holds the
        // user's genuine `codex login` session and no cli_backup exists.
        Path tempHome = Files.createTempDirectory("codex-provider-legacy-backup-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(
                codexDir.resolve("auth.json"),
                "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"legacy-oauth\"}}",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject legacyProvider = new JsonObject();
        legacyProvider.addProperty("id", "legacy-config-only");
        legacyProvider.addProperty("configToml", "model = \"legacy-model\"\n");
        JsonObject nextProvider = provider(
                "next",
                "model = \"next-model\"\n",
                "{\"OPENAI_API_KEY\":\"next-key\"}"
        );

        manager.transitionProvider(legacyProvider, nextProvider, false, () -> { });

        // The user's OAuth session must have been stashed before the overwrite.
        assertTrue(Files.exists(codexDir.resolve("auth.json.cli_backup")));
        assertEquals("next-key", manager.readAuthJson().get("OPENAI_API_KEY").getAsString());

        // Leaving managed mode restores the legacy OAuth session.
        manager.transitionProvider(nextProvider, null, true, () -> { });
        assertEquals("legacy-oauth", manager.readAuthJson()
                .getAsJsonObject("tokens").get("access_token").getAsString());
        assertFalse(Files.exists(codexDir.resolve("auth.json.cli_backup")));
    }

    @Test
    public void shouldPreserveUnmanagedAuthWhenLeavingLegacyManagedProvider() throws Exception {
        // Legacy state as above; the user goes straight from the legacy managed
        // provider to CLI-login without ever switching under the new code.
        Path tempHome = Files.createTempDirectory("codex-provider-legacy-deactivate-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(
                codexDir.resolve("auth.json"),
                "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"legacy-oauth\"}}",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject legacyProvider = new JsonObject();
        legacyProvider.addProperty("id", "legacy-config-only");
        legacyProvider.addProperty("configToml", "model = \"legacy-model\"\n");

        manager.transitionProvider(legacyProvider, null, true, () -> { });

        // The unmanaged local credential survives — no backup existed to restore,
        // and the current auth.json is not the provider's own credential.
        assertEquals("legacy-oauth", manager.readAuthJson()
                .getAsJsonObject("tokens").get("access_token").getAsString());
    }

    @Test
    public void shouldNotBackupOutgoingProvidersOwnCredential() throws Exception {
        // Transition A→B where auth.json currently holds A's managed credential:
        // there is no user credential to preserve, so no backup must appear
        // (backing up A's credential would later restore it as if it were local).
        Path tempHome = Files.createTempDirectory("codex-provider-owned-auth-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject providerA = provider(
                "a",
                "model = \"a-model\"\n",
                "{\"OPENAI_API_KEY\":\"a-key\"}"
        );
        JsonObject providerB = provider(
                "b",
                "model = \"b-model\"\n",
                "{\"OPENAI_API_KEY\":\"b-key\"}"
        );

        // Simulate legacy: A applied without a backup (write its auth directly).
        manager.transitionProvider(null, providerA, false, () -> { });
        Files.deleteIfExists(codexDir.resolve("auth.json.cli_backup"));

        manager.transitionProvider(providerA, providerB, false, () -> { });
        assertFalse(Files.exists(codexDir.resolve("auth.json.cli_backup")));
        assertEquals("b-key", manager.readAuthJson().get("OPENAI_API_KEY").getAsString());

        // Deactivating B with no backup removes B's managed credential.
        manager.transitionProvider(providerB, null, true, () -> { });
        assertFalse(Files.exists(codexDir.resolve("auth.json")));
    }

    @Test
    public void shouldNotConfuseProviderOAuthWithLocalCredentialBackup() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-provider-oauth-ownership-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(
                codexDir.resolve("auth.json"),
                "{\"OPENAI_API_KEY\":\"local-key\"}",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject oauthProvider = provider(
                "oauth-provider",
                "model = \"oauth-model\"\n",
                "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"provider-oauth\"}}"
        );
        JsonObject nextProvider = provider(
                "next-provider",
                "model = \"next-model\"\n",
                "{\"OPENAI_API_KEY\":\"next-key\"}"
        );

        manager.transitionProvider(null, oauthProvider, false, () -> { });
        manager.transitionProvider(oauthProvider, nextProvider, false, () -> { });
        manager.transitionProvider(nextProvider, null, true, () -> { });

        assertEquals("local-key", manager.readAuthJson().get("OPENAI_API_KEY").getAsString());
    }

    @Test
    public void shouldRoundTripAllTomlBasicStringControlEscapes() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-toml-control-escape-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(
                codexDir.resolve("config.toml"),
                "control = \"a\\bb\\fc\\u0001z\"\n",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        manager.updateConfigToml(config -> {
            config.put("touched", true);
            return true;
        });

        String written = Files.readString(codexDir.resolve("config.toml"), StandardCharsets.UTF_8);
        assertTrue(written.contains("a\\bb\\fc\\u0001z"));
        assertEquals("a\bb\fc" + (char) 1 + "z", manager.readConfigToml().get("control"));
    }

    @Test
    public void shouldRejectProviderOwnedGlobalSectionsWithoutChangingFiles() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-provider-global-section-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Path configPath = codexDir.resolve("config.toml");
        Files.writeString(configPath, "model = \"existing\"\n", StandardCharsets.UTF_8);
        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject provider = provider(
                "invalid",
                "model = \"invalid\"\n[mcp_servers.bad]\ncommand = \"bad\"\n",
                "{\"OPENAI_API_KEY\":\"new-key\"}"
        );

        try {
            manager.transitionProvider(null, provider, false, () -> { });
            fail("Expected provider-owned MCP section to be rejected");
        } catch (java.io.IOException expected) {
            assertTrue(expected.getMessage().contains("mcp_servers"));
        }

        assertEquals("model = \"existing\"\n", Files.readString(configPath, StandardCharsets.UTF_8));
        assertFalse(Files.exists(codexDir.resolve("auth.json")));
    }

    @Test
    public void shouldRestoreCliOAuthAfterCustomProviderAndRollbackCommitFailure() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-provider-auth-transaction-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Path configPath = codexDir.resolve("config.toml");
        Path authPath = codexDir.resolve("auth.json");
        String oauth = "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"oauth-token\"}}";
        Files.writeString(configPath, "custom_global = \"keep\"\n", StandardCharsets.UTF_8);
        Files.writeString(authPath, oauth, StandardCharsets.UTF_8);

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject provider = provider(
                "custom",
                "model = \"custom-model\"\n",
                "{\"OPENAI_API_KEY\":\"custom-key\"}"
        );
        manager.transitionProvider(null, provider, false, () -> { });
        assertEquals("custom-key", manager.readAuthJson().get("OPENAI_API_KEY").getAsString());

        manager.transitionProvider(provider, null, true, () -> { });
        assertEquals("oauth-token", manager.readAuthJson()
                .getAsJsonObject("tokens").get("access_token").getAsString());
        assertFalse(Files.exists(codexDir.resolve("auth.json.cli_backup")));
        assertEquals("keep", manager.readConfigToml().get("custom_global"));
        assertFalse(manager.readConfigToml().containsKey("model"));

        String configBeforeFailure = Files.readString(configPath, StandardCharsets.UTF_8);
        String authBeforeFailure = Files.readString(authPath, StandardCharsets.UTF_8);
        try {
            manager.transitionProvider(null, provider, false, () -> {
                throw new java.io.IOException("commit failed");
            });
            fail("Expected provider-state commit failure");
        } catch (java.io.IOException expected) {
            assertTrue(expected.getMessage().contains("commit failed"));
        }
        assertEquals(configBeforeFailure, Files.readString(configPath, StandardCharsets.UTF_8));
        assertEquals(authBeforeFailure, Files.readString(authPath, StandardCharsets.UTF_8));
        assertFalse(Files.exists(codexDir.resolve("config.toml.provider_backup")));
    }

    private JsonObject provider(String id, String configToml, String authJson) {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", id);
        provider.addProperty("configToml", configToml);
        provider.addProperty("authJson", authJson);
        return provider;
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (!homeOverridden) {
            originalHomeDir = getCachedHomeDirectory();
            homeOverridden = true;
        }
        setCachedHomeDirectory(tempHome.toString());
    }

    private String getCachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }
}

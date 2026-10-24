package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.tomlj.Toml;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class CodexConfigCompatibilityTest {
    private static final String LEGACY_CONFIG = "# Original settings must be recoverable.\n"
            + "model = \"gpt-6.1-sol\"\n"
            + "disable_response_storage = true\nnetwork_access = \"enabled\"\nwindows_wsl_setup_acknowledged = true\n"
            + "[model_aliases]\n\"gpt-6.1-sol\" = \"vendor/gpt-6.1-sol\"\n"
            + "[mcp_servers.fixture]\ncommand = \"node\"\nenabled = false\n"
            + "[[skills.config]]\npath = 'C:\\skills\\example\\SKILL.md'\nenabled = false\n";

    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void migratesLegacyConfigAndPreservesLocalFeaturesAndOriginalBackup() throws Exception {
        CodexSettingsManager manager = manager(LEGACY_CONFIG);
        manager.prepareNativeConfig(() -> true);

        String nativeConfig = Files.readString(manager.getConfigTomlPath());
        assertFalse(nativeConfig.contains("disable_response_storage"));
        assertFalse(nativeConfig.contains("windows_wsl_setup_acknowledged"));
        assertFalse(nativeConfig.contains("model_aliases"));
        assertEquals(Boolean.TRUE, Toml.parse(nativeConfig).getBoolean("sandbox_workspace_write.network_access"));
        assertEquals("node", Toml.parse(nativeConfig).getString("mcp_servers.fixture.command"));
        assertEquals(1, Toml.parse(nativeConfig).getArray("skills.config").size());
        assertEquals(LEGACY_CONFIG, Files.readString(sibling(manager, CodexSettingsManager.CLI_MIGRATION_BACKUP_FILE_NAME)));
        assertEquals("vendor/gpt-6.1-sol", new CodexSettingsManager(new Gson(), manager.getConfigTomlPath().getParent())
                .resolveModelAlias("gpt-6.1-sol"));
    }

    @Test
    public void nativeSettingsTakePrecedenceAndUnknownFieldsRemainVisible() throws Exception {
        CodexSettingsManager manager = manager("network_access = \"enabled\"\nunknown_user_setting = true\n"
                + "[sandbox_workspace_write]\nnetwork_access = false\nwritable_roots = [\"C:/workspace\"]\n");
        manager.prepareNativeConfig(() -> true);

        var nativeConfig = Toml.parse(Files.readString(manager.getConfigTomlPath()));
        assertEquals(Boolean.FALSE, nativeConfig.getBoolean("sandbox_workspace_write.network_access"));
        assertEquals("C:/workspace", nativeConfig.getArray("sandbox_workspace_write.writable_roots").getString(0));
        assertEquals(Boolean.TRUE, nativeConfig.getBoolean("unknown_user_setting"));
    }

    @Test
    public void handlesDisabledAndBooleanNetworkValuesWithoutInventingNativeProfileFields() throws Exception {
        for (String value : new String[]{"\"disabled\"", "false", "true"}) {
            CodexSettingsManager manager = manager("network_access = " + value + "\n"
                    + "[profiles.fixture]\nnetwork_access = \"disabled\"\ndisable_response_storage = true\n");
            manager.prepareNativeConfig(() -> true);
            var config = Toml.parse(Files.readString(manager.getConfigTomlPath()));
            assertEquals("true".equals(value), config.getBoolean("sandbox_workspace_write.network_access"));
            assertEquals("disabled", config.getString("profiles.fixture.network_access"));
            assertFalse(config.getTable("profiles.fixture").contains("sandbox_workspace_write"));
            assertFalse(config.getTable("profiles.fixture").contains("disable_response_storage"));
        }
    }

    @Test
    public void doesNotGuessUnrecognizedNetworkValues() throws Exception {
        CodexSettingsManager manager = manager("network_access = \"unexpected\"\n");
        manager.prepareNativeConfig(() -> true);
        assertEquals("network_access = \"unexpected\"\n", Files.readString(manager.getConfigTomlPath()));
        assertFalse(Files.exists(sibling(manager, CodexSettingsManager.CLI_MIGRATION_BACKUP_FILE_NAME)));
    }

    @Test
    public void migrationIsIdempotentAndDoesNotOverwriteOriginalBackup() throws Exception {
        CodexSettingsManager manager = manager(LEGACY_CONFIG);
        manager.prepareNativeConfig(() -> true);
        Path path = manager.getConfigTomlPath();
        var modified = Files.getLastModifiedTime(path);
        manager.prepareNativeConfig(() -> true);
        assertEquals(modified, Files.getLastModifiedTime(path));
        manager.updateConfigToml(config -> {
            config.put("disable_response_storage", true);
            return true;
        });
        assertEquals(LEGACY_CONFIG, Files.readString(sibling(manager, CodexSettingsManager.CLI_MIGRATION_BACKUP_FILE_NAME)));
        assertFalse(Files.readString(path).contains("disable_response_storage"));
    }

    @Test
    public void deniedAuthorizationDoesNotReadOrModifyConfiguration() throws Exception {
        CodexSettingsManager manager = manager(LEGACY_CONFIG);
        try {
            manager.prepareNativeConfig(() -> false);
            fail("Unauthorized migration must fail");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("not authorized"));
        }
        assertEquals(LEGACY_CONFIG, Files.readString(manager.getConfigTomlPath()));
        assertFalse(Files.exists(sibling(manager, CodexSettingsManager.PLUGIN_CONFIG_FILE_NAME)));
        assertFalse(Files.exists(sibling(manager, CodexSettingsManager.CLI_MIGRATION_BACKUP_FILE_NAME)));
    }

    @Test
    public void malformedConfigurationIsNotOverwritten() throws Exception {
        CodexSettingsManager manager = manager("model = [\n");
        try {
            manager.prepareNativeConfig(() -> true);
            fail("Malformed configuration must fail");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("TOML"));
        }
        assertEquals("model = [\n", Files.readString(manager.getConfigTomlPath()));
    }

    @Test
    public void providerSwitchesRestoreAliasesWithoutReintroducingNativeWarnings() throws Exception {
        CodexSettingsManager manager = manager(LEGACY_CONFIG);
        JsonObject first = provider("first", "first-alias");
        JsonObject second = provider("second", "second-alias");
        manager.prepareNativeConfig(() -> true);
        manager.transitionProvider(null, first, false, () -> { });
        assertTrue(manager.isProviderApplied(first));
        assertEquals("first-alias", manager.resolveModelAlias("gpt-6.1-sol"));
        manager.transitionProvider(first, second, false, () -> { });
        assertEquals("second-alias", manager.resolveModelAlias("gpt-6.1-sol"));
        assertTrue(manager.isProviderApplied(second));
        manager.transitionProvider(second, null, true, () -> { });
        assertEquals("vendor/gpt-6.1-sol", manager.resolveModelAlias("gpt-6.1-sol"));
        assertFalse(Files.readString(manager.getConfigTomlPath()).contains("model_aliases"));
        assertFalse(Files.readString(manager.getConfigTomlPath()).contains("disable_response_storage"));
    }

    @Test
    public void failedProviderCommitRestoresNativeConfigAndPluginAliases() throws Exception {
        CodexSettingsManager manager = manager(LEGACY_CONFIG);
        manager.prepareNativeConfig(() -> true);
        String beforeConfig = Files.readString(manager.getConfigTomlPath());
        String beforePlugin = Files.readString(sibling(manager, CodexSettingsManager.PLUGIN_CONFIG_FILE_NAME));
        try {
            manager.transitionProvider(null, provider("first", "first-alias"), false,
                    () -> { throw new IOException("fixture commit failed"); });
            fail("Failed commit must propagate");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("fixture commit failed"));
        }
        assertEquals(beforeConfig, Files.readString(manager.getConfigTomlPath()));
        assertEquals(beforePlugin, Files.readString(sibling(manager, CodexSettingsManager.PLUGIN_CONFIG_FILE_NAME)));
        assertEquals("vendor/gpt-6.1-sol", manager.resolveModelAlias("gpt-6.1-sol"));
    }

    @Test
    public void clearingAliasesDoesNotResurrectPreviousSidecarValues() throws Exception {
        CodexSettingsManager manager = manager(LEGACY_CONFIG);
        manager.prepareNativeConfig(() -> true);
        manager.updateConfigToml(config -> {
            config.remove("model_aliases");
            return true;
        });
        assertEquals("gpt-6.1-sol", manager.resolveModelAlias("gpt-6.1-sol"));
        assertFalse(Files.readString(manager.getConfigTomlPath()).contains("model_aliases"));
    }

    @Test
    public void directWritesKeepInputUnchangedAndOnlyNativeFieldsReachConfigToml() throws Exception {
        CodexSettingsManager manager = manager("");
        Map<String, Object> input = new java.util.LinkedHashMap<>();
        input.put("model_aliases", Map.of("gpt-6.1-sol", "alias"));
        input.put("network_access", "enabled");
        manager.writeConfigToml(input);
        assertEquals("enabled", input.get("network_access"));
        assertTrue(input.containsKey("model_aliases"));
        assertEquals("alias", manager.resolveModelAlias("gpt-6.1-sol"));
        assertEquals(Boolean.TRUE, Toml.parse(Files.readString(manager.getConfigTomlPath()))
                .getBoolean("sandbox_workspace_write.network_access"));
    }

    private CodexSettingsManager manager(String config) throws IOException {
        Path home = temporary.newFolder().toPath();
        Files.writeString(home.resolve("config.toml"), config, StandardCharsets.UTF_8);
        return new CodexSettingsManager(new Gson(), home);
    }

    private static Path sibling(CodexSettingsManager manager, String name) {
        return manager.getConfigTomlPath().resolveSibling(name);
    }

    private static JsonObject provider(String id, String alias) {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", id);
        provider.addProperty("configToml", "model = \"gpt-6.1-sol\"\ndisable_response_storage = true\nnetwork_access = \"enabled\"\n"
                + "[model_aliases]\n\"gpt-6.1-sol\" = \"" + alias + "\"\n");
        return provider;
    }
}

package com.github.claudecodegui.bridge;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class EnvironmentConfiguratorCodexHomeTest {
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void readsProviderEnvironmentKeysFromTheResolvedConfigPath() throws Exception {
        Path home = temporary.newFolder("custom codex home").toPath();
        Path config = home.resolve("config.toml");
        Files.writeString(config, "[model_providers.fixture]\nbase_url = 'https://example.invalid'\n"
                + "env_key = 'FIXTURE_PROVIDER_KEY'\n[model_providers.other]\nenv_key = \"OTHER_PROVIDER_KEY\"\n");
        assertEquals(Set.of("FIXTURE_PROVIDER_KEY", "OTHER_PROVIDER_KEY"),
                EnvironmentConfigurator.parseCodexConfigEnvKeys(config));
    }

    @Test
    public void missingConfigDoesNotInventEnvironmentKeys() {
        assertTrue(EnvironmentConfigurator.parseCodexConfigEnvKeys(temporary.getRoot().toPath().resolve("absent.toml")).isEmpty());
    }
}

package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class CodemossSettingsServiceCommitAiConfigTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void shouldDefaultCommitAiToCodexWhenBothProvidersAreConfiguredAndInstalled() throws Exception {
        Path tempHome = Files.createTempDirectory("commit-ai-default-codex-home");
        useTemporaryHomeDirectory(tempHome);
        writeConfig(tempHome, "claude-a", "codex-a");
        installSdk(tempHome, "claude-sdk", "@anthropic-ai/claude-agent-sdk", "0.2.88");
        installSdk(tempHome, "codex-sdk", "@openai/codex-sdk", "0.117.0");

        CodemossSettingsService service = new CodemossSettingsService();

        JsonObject config = invokeGetCommitAiConfig(service);

        assertTrue(config.get("provider").isJsonNull());
        assertEquals("codex", config.get("effectiveProvider").getAsString());
        assertEquals("auto", config.get("resolutionSource").getAsString());
        assertTrue(config.getAsJsonObject("availability").get("claude").getAsBoolean());
        assertTrue(config.getAsJsonObject("availability").get("codex").getAsBoolean());
        assertEquals("claude-sonnet-4-6", config.getAsJsonObject("models").get("claude").getAsString());
        assertEquals("gpt-5.5", config.getAsJsonObject("models").get("codex").getAsString());
    }

    @Test
    public void shouldDefaultCommitAiToClaudeWhenOnlyClaudeIsAvailable() throws Exception {
        Path tempHome = Files.createTempDirectory("commit-ai-default-claude-home");
        useTemporaryHomeDirectory(tempHome);
        writeConfig(tempHome, "claude-a", "");
        installSdk(tempHome, "claude-sdk", "@anthropic-ai/claude-agent-sdk", "0.2.88");

        CodemossSettingsService service = new CodemossSettingsService();

        JsonObject config = invokeGetCommitAiConfig(service);

        assertTrue(config.get("provider").isJsonNull());
        assertEquals("claude", config.get("effectiveProvider").getAsString());
        assertEquals("auto", config.get("resolutionSource").getAsString());
        assertTrue(config.getAsJsonObject("availability").get("claude").getAsBoolean());
        assertFalse(config.getAsJsonObject("availability").get("codex").getAsBoolean());
    }

    @Test
    public void shouldPersistManualCommitAiProviderAndModels() throws Exception {
        Path tempHome = Files.createTempDirectory("commit-ai-manual-home");
        useTemporaryHomeDirectory(tempHome);
        writeConfig(tempHome, "claude-a", "codex-a");
        installSdk(tempHome, "claude-sdk", "@anthropic-ai/claude-agent-sdk", "0.2.88");
        installSdk(tempHome, "codex-sdk", "@openai/codex-sdk", "0.117.0");

        CodemossSettingsService service = new CodemossSettingsService();

        invokeSetCommitAiConfig(service, "claude", "claude-opus-4-7", "gpt-5.4");
        JsonObject config = invokeGetCommitAiConfig(service);

        assertEquals("claude", config.get("provider").getAsString());
        assertEquals("claude", config.get("effectiveProvider").getAsString());
        assertEquals("manual", config.get("resolutionSource").getAsString());
        assertEquals("claude-opus-4-7", config.getAsJsonObject("models").get("claude").getAsString());
        assertEquals("gpt-5.4", config.getAsJsonObject("models").get("codex").getAsString());
    }

    @Test
    public void shouldKeepManualCommitAiProviderWhenUnavailable() throws Exception {
        Path tempHome = Files.createTempDirectory("commit-ai-unavailable-home");
        useTemporaryHomeDirectory(tempHome);
        writeConfig(tempHome, "", "");

        CodemossSettingsService service = new CodemossSettingsService();

        invokeSetCommitAiConfig(service, "claude", "claude-opus-4-7", "gpt-5.4");
        JsonObject config = invokeGetCommitAiConfig(service);

        assertEquals("claude", config.get("provider").getAsString());
        assertTrue(config.get("effectiveProvider").isJsonNull());
        assertEquals("unavailable", config.get("resolutionSource").getAsString());
        assertFalse(config.getAsJsonObject("availability").get("claude").getAsBoolean());
        assertFalse(config.getAsJsonObject("availability").get("codex").getAsBoolean());
    }

    @Test
    public void shouldNotMutatePromptEnhancerConfigWhenSavingCommitAiConfig() throws Exception {
        Path tempHome = Files.createTempDirectory("commit-ai-isolated-home");
        useTemporaryHomeDirectory(tempHome);
        writeConfig(tempHome, "claude-a", "codex-a");
        installSdk(tempHome, "claude-sdk", "@anthropic-ai/claude-agent-sdk", "0.2.88");
        installSdk(tempHome, "codex-sdk", "@openai/codex-sdk", "0.117.0");

        CodemossSettingsService service = new CodemossSettingsService();
        invokeSetPromptEnhancerConfig(service, "claude", "claude-opus-4-6", "gpt-5.4");

        invokeSetCommitAiConfig(service, "codex", "claude-opus-4-7", "gpt-5.5");

        JsonObject promptEnhancerConfig = invokeGetPromptEnhancerConfig(service);
        JsonObject commitAiConfig = invokeGetCommitAiConfig(service);

        assertEquals("claude", promptEnhancerConfig.get("provider").getAsString());
        assertEquals("claude-opus-4-6", promptEnhancerConfig.getAsJsonObject("models").get("claude").getAsString());
        assertEquals("gpt-5.4", promptEnhancerConfig.getAsJsonObject("models").get("codex").getAsString());

        assertEquals("codex", commitAiConfig.get("provider").getAsString());
        assertEquals("gpt-5.5", commitAiConfig.getAsJsonObject("models").get("codex").getAsString());
        assertEquals("claude-opus-4-7", commitAiConfig.getAsJsonObject("models").get("claude").getAsString());
    }

    private JsonObject invokeGetCommitAiConfig(CodemossSettingsService service) throws Exception {
        Method method;
        try {
            method = CodemossSettingsService.class.getMethod("getCommitAiConfig");
        } catch (NoSuchMethodException e) {
            fail("CodemossSettingsService should expose getCommitAiConfig()");
            throw e;
        }
        return (JsonObject) method.invoke(service);
    }

    private void invokeSetCommitAiConfig(
            CodemossSettingsService service,
            String provider,
            String claudeModel,
            String codexModel
    ) throws Exception {
        Method method;
        try {
            method = CodemossSettingsService.class.getMethod(
                    "setCommitAiConfig",
                    String.class,
                    String.class,
                    String.class
            );
        } catch (NoSuchMethodException e) {
            fail("CodemossSettingsService should expose setCommitAiConfig(provider, claudeModel, codexModel)");
            throw e;
        }
        method.invoke(service, provider, claudeModel, codexModel);
    }

    private JsonObject invokeGetPromptEnhancerConfig(CodemossSettingsService service) throws Exception {
        Method method = CodemossSettingsService.class.getMethod("getPromptEnhancerConfig");
        return (JsonObject) method.invoke(service);
    }

    private void invokeSetPromptEnhancerConfig(
            CodemossSettingsService service,
            String provider,
            String claudeModel,
            String codexModel
    ) throws Exception {
        Method method = CodemossSettingsService.class.getMethod(
                "setPromptEnhancerConfig",
                String.class,
                String.class,
                String.class
        );
        method.invoke(service, provider, claudeModel, codexModel);
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
        Files.createDirectories(tempHome.resolve(".codemoss"));
    }

    private void writeConfig(Path tempHome, String currentClaude, String currentCodex) throws Exception {
        JsonObject config = new JsonObject();

        JsonObject claude = new JsonObject();
        claude.addProperty("current", currentClaude);
        JsonObject claudeProviders = new JsonObject();
        if (currentClaude != null && !currentClaude.isEmpty()) {
            JsonObject provider = new JsonObject();
            provider.addProperty("name", "Claude A");
            provider.add("settingsConfig", new JsonObject());
            claudeProviders.add(currentClaude, provider);
        }
        claude.add("providers", claudeProviders);
        config.add("claude", claude);

        JsonObject codex = new JsonObject();
        codex.addProperty("current", currentCodex);
        codex.addProperty("localConfigAuthorized", false);
        JsonObject codexProviders = new JsonObject();
        if (currentCodex != null && !currentCodex.isEmpty()) {
            JsonObject provider = new JsonObject();
            provider.addProperty("name", "Codex A");
            provider.add("configToml", new JsonObject());
            provider.add("authJson", new JsonObject());
            codexProviders.add(currentCodex, provider);
        }
        codex.add("providers", codexProviders);
        config.add("codex", codex);

        Files.writeString(
                tempHome.resolve(".codemoss").resolve("config.json"),
                config.toString()
        );
    }

    private void installSdk(Path tempHome, String sdkId, String npmPackage, String version) throws Exception {
        Path packageDir = tempHome.resolve(".codemoss")
                .resolve("dependencies")
                .resolve(sdkId)
                .resolve("node_modules");

        for (String segment : npmPackage.split("/")) {
            packageDir = packageDir.resolve(segment);
        }

        Files.createDirectories(packageDir);
        JsonObject pkgJson = new JsonObject();
        pkgJson.addProperty("name", npmPackage);
        pkgJson.addProperty("version", version);
        Files.writeString(packageDir.resolve("package.json"), pkgJson.toString());
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

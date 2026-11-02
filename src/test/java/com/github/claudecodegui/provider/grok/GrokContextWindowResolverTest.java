package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.handler.provider.ModelProviderHandler;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Unit tests for Grok context window limit resolution from ~/.grok cache and config.
 */
public class GrokContextWindowResolverTest {

    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    private static Integer resolveViaReflection(String model, Path grokHome) {
        try {
            Class<?> clazz = Class.forName("com.github.claudecodegui.provider.grok.GrokContextWindowResolver");
            try {
                Method m = clazz.getMethod("resolve", String.class, Path.class);
                return (Integer) m.invoke(null, model, grokHome);
            } catch (NoSuchMethodException e) {
                Method m = clazz.getMethod("resolve", String.class);
                return (Integer) m.invoke(null, model);
            }
        } catch (ClassNotFoundException e) {
            throw new AssertionError("GrokContextWindowResolver is not implemented yet", e);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    public void readsContextWindowFromModelsCacheJson() throws Exception {
        Path grokHome = temporary.newFolder(".grok").toPath();
        String modelsCache = """
                {
                  "models": {
                    "grok-4.7": {
                      "context_window": 256000
                    },
                    "grok-4.7-build-fast": {
                      "context_window": 256000
                    }
                  }
                }
                """;
        Files.writeString(grokHome.resolve("models_cache.json"), modelsCache, StandardCharsets.UTF_8);

        assertEquals(Integer.valueOf(256000), resolveViaReflection("grok-4.7", grokHome));
        assertEquals(Integer.valueOf(256000), resolveViaReflection("grok-4.7-build-fast", grokHome));
    }

    @Test
    public void resolvesProfileMappingAndConfigDefault() throws Exception {
        Path grokHome = temporary.newFolder(".grok-profiles").toPath();
        String modelsCache = """
                {
                  "models": {
                    "grok-4.7": {
                      "context_window": 256000
                    },
                    "grok-4.7-build-fast": {
                      "context_window": 256000
                    }
                  }
                }
                """;
        Files.writeString(grokHome.resolve("models_cache.json"), modelsCache, StandardCharsets.UTF_8);

        String configToml = """
                [models]
                default = "grok-4.7"

                [model."custom-fast"]
                model = "grok-4.7-build-fast"
                """;
        Files.writeString(grokHome.resolve("config.toml"), configToml, StandardCharsets.UTF_8);

        assertEquals(Integer.valueOf(256000), resolveViaReflection("custom-fast", grokHome));
        assertEquals(Integer.valueOf(256000), resolveViaReflection("default", grokHome));
        assertEquals(Integer.valueOf(256000), resolveViaReflection("__config_default__", grokHome));
        assertNull(resolveViaReflection("non-existent-model", grokHome));
    }

    @Test
    public void modelContextLimitsContainsStaticEntriesForGrok47() {
        assertEquals(256_000, ModelProviderHandler.getModelContextLimit("grok-4.7"));
        assertEquals(256_000, ModelProviderHandler.getModelContextLimit("grok-4.7-build-fast"));
        assertEquals(256_000, ModelProviderHandler.getModelContextLimit("grok-4.7-build"));
        // Existing static entries preserved
        assertEquals(500_000, ModelProviderHandler.getModelContextLimit("grok-4.6"));
        assertEquals(128_000, ModelProviderHandler.getModelContextLimit("grok-2"));
        assertEquals(500_000, ModelProviderHandler.getModelContextLimit("grok-build"));
    }

    @Test
    public void modelProviderHandlerDelegatesToResolverForGrok() {
        assertEquals(256_000, ModelProviderHandler.resolveContextLimit("grok", "grok-4.7", null));
    }
}

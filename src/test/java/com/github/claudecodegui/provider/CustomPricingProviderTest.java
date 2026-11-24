package com.github.claudecodegui.provider;

import com.github.claudecodegui.settings.ConfigPathManager;
import com.github.claudecodegui.settings.ModelPricing;
import com.google.gson.Gson;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

public class CustomPricingProviderTest {

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    @Test
    public void setInstanceForTestsOverridesSingletonAndNullRestoresDefault() throws IOException {
        CustomPricingProvider injected = CustomPricingProvider.createForTests(
                temp.newFolder().toPath().resolve("config.json"));
        try {
            CustomPricingProvider.setInstanceForTests(injected);
            assertSame(injected, CustomPricingProvider.getInstance());
            assertTrue(CustomPricingProvider.getInstance().getPricing("claude", "any-model").isEmpty());
        } finally {
            CustomPricingProvider.setInstanceForTests(null);
        }
        // After reset the lazily-created default instance takes over again.
        assertNotSame(injected, CustomPricingProvider.getInstance());
    }

    @Test
    public void shouldMatchRoutePrefixedPricingWhenHistoryStoresRoutedModel() throws IOException {
        CustomPricingProvider provider = newProvider(config(entry("ppio/pa/gpt-5.5", 2.0)));

        Optional<ModelPricing> pricing = provider.getPricing("claude", "pa/gpt-5.5");

        assertInputRate(pricing, 2.0);
    }

    @Test
    public void shouldKeepExactPricingBeforeRoutePrefixFallback() throws IOException {
        CustomPricingProvider provider = newProvider(config(String.join(",",
                entry("pa/gpt-5.5", 1.0),
                entry("ppio/pa/gpt-5.5", 2.0)
        )));

        Optional<ModelPricing> pricing = provider.getPricing("claude", "pa/gpt-5.5");

        assertInputRate(pricing, 1.0);
    }

    @Test
    public void shouldKeepOneMillionContextSuffixFallback() throws IOException {
        CustomPricingProvider provider = newProvider(config(entry("deepseek-v4-pro", 3.0)));

        Optional<ModelPricing> pricing = provider.getPricing("claude", "deepseek-v4-pro[1m]");

        assertInputRate(pricing, 3.0);
    }

    @Test
    public void shouldMatchConfiguredOneMillionContextSuffixWhenHistoryStoresBaseModel() throws IOException {
        CustomPricingProvider provider = newProvider(config(entry("deepseek-v4-pro[1m]", 3.5)));

        Optional<ModelPricing> pricing = provider.getPricing("claude", "deepseek-v4-pro");

        assertInputRate(pricing, 3.5);
    }

    @Test
    public void shouldMatchRoutePrefixedPricingWithOneMillionContextSuffix() throws IOException {
        CustomPricingProvider provider = newProvider(config(entry("ppio/deepseek-v4-pro[1m]", 4.0)));

        Optional<ModelPricing> pricing = provider.getPricing("claude", "deepseek-v4-pro");

        assertInputRate(pricing, 4.0);
    }

    @Test
    public void shouldNotGuessRoutePrefixPricingWhenMultipleCandidatesMatch() throws IOException {
        CustomPricingProvider provider = newProvider(config(String.join(",",
                entry("ppio/pa/gpt-5.5", 2.0),
                entry("openrouter/pa/gpt-5.5", 5.0)
        )));

        Optional<ModelPricing> pricing = provider.getPricing("claude", "pa/gpt-5.5");

        assertTrue(pricing.isEmpty());
    }

    private CustomPricingProvider newProvider(String configJson) throws IOException {
        Path configPath = temp.newFile("config.json").toPath();
        Files.writeString(configPath, configJson, StandardCharsets.UTF_8);
        return new CustomPricingProvider(new TestConfigPathManager(configPath));
    }

    private static String config(String claudeEntries) {
        return """
                {
                  "customModelPricing": {
                    "claude": {
                      %s
                    }
                  }
                }
                """.formatted(claudeEntries);
    }

    private static String entry(String modelId, double inputCostPer1M) {
        // Properly escape modelId for JSON key using Gson
        String escapedKey = new Gson().toJson(modelId);
        return "%s: {\"inputCostPer1M\": %.1f}".formatted(escapedKey, inputCostPer1M);
    }

    private static void assertInputRate(Optional<ModelPricing> pricing, double expected) {
        assertTrue(pricing.isPresent());
        assertEquals(expected, pricing.get().inputCostPer1M(), 0.000001);
    }

    private static final class TestConfigPathManager extends ConfigPathManager {
        private final Path configPath;

        private TestConfigPathManager(Path configPath) {
            this.configPath = configPath;
        }

        @Override
        public Path getConfigFilePath() {
            return configPath;
        }
    }
}

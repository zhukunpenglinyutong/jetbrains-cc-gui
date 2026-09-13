package com.github.claudecodegui.util;

import com.github.claudecodegui.provider.CustomPricingProvider;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class UsageCostCalculatorTest {

    @Test
    public void calculatesClaudeTurnCostWithCacheBreakdown() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 1200);
        usage.addProperty("cache_creation_input_tokens", 4096);
        usage.addProperty("cache_read_input_tokens", 363100);
        usage.addProperty("output_tokens", 4560);

        double cost = UsageCostCalculator.calculateTurnCostUsd("claude", usage, "claude-sonnet-4-6");

        assertEquals(0.19629, cost, 0.000001);
    }

    @Test
    public void calculatesCodexTurnCostFromNormalizedTurnUsage() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 690);
        usage.addProperty("cache_creation_input_tokens", 0);
        usage.addProperty("cache_read_input_tokens", 36310);
        usage.addProperty("output_tokens", 353);

        double cost = UsageCostCalculator.calculateTurnCostUsd("codex", usage, "gpt-5.1");

        assertEquals(0.00893125, cost, 0.0000001);
    }

    @Test
    public void acceptsCodexCachedInputTokenAliasForTurnCost() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 690);
        usage.addProperty("cached_input_tokens", 36310);
        usage.addProperty("output_tokens", 353);

        double cost = UsageCostCalculator.calculateTurnCostUsd("codex", usage, "gpt-5.1");

        assertEquals(0.00893125, cost, 0.0000001);
    }

    @Test
    public void pricesGpt56FamilyIncludingAlias() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 690);
        usage.addProperty("cache_read_input_tokens", 36310);
        usage.addProperty("output_tokens", 353);

        // gpt-5.6-sol: input 5.0 / output 30.0 / cacheRead 0.5 per 1M.
        double solCost = UsageCostCalculator.calculateTurnCostUsd("codex", usage, "gpt-5.6-sol");
        assertEquals(0.032195, solCost, 0.0000001);

        // Bare "gpt-5.6" is aliased to gpt-5.6-sol, matching CodexPricingTable.
        double aliasCost = UsageCostCalculator.calculateTurnCostUsd("codex", usage, "gpt-5.6");
        assertEquals(0.032195, aliasCost, 0.0000001);
    }

    @Test
    public void pricesMappedCustomModelUsingConfiguredRates() throws Exception {
        Path config = Files.createTempFile("pricing-test", ".json");
        Files.writeString(config, "{\"customModelPricing\":{\"claude\":{\"deepseek-v4-flash\":{"
                + "\"inputCostPer1M\":1.0,\"outputCostPer1M\":2.0,\"cacheReadCostPer1M\":0.02}}}}");
        CustomPricingProvider.setInstanceForTests(CustomPricingProvider.createForTests(config));
        try {
            // Turn from the real-world deepseek-v4-flash session:
            // 1.2M input (95% cache-hit => 62K uncached + 1178K read), 11.1K output.
            JsonObject usage = new JsonObject();
            usage.addProperty("input_tokens", 62000);
            usage.addProperty("cache_creation_input_tokens", 0);
            usage.addProperty("cache_read_input_tokens", 1178000);
            usage.addProperty("output_tokens", 11100);

            // Model arrives as the Claude slot ID with the 1m suffix; pricing lookup must
            // resolve it to the configured base model (mapping done by ModelProviderHandler).
            double cost = UsageCostCalculator.calculateTurnCostUsd("claude", usage, "deepseek-v4-flash[1m]");

            // 0.062 * 1 + 1.178 * 0.02 + 0.0111 * 2 = 0.10776
            assertEquals(0.10776, cost, 0.00001);
        } finally {
            CustomPricingProvider.setInstanceForTests(null);
            Files.deleteIfExists(config);
        }
    }

    @Test
    public void returnsNullWhenNoBuiltInOrCustomPriceMatches() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 1200);
        usage.addProperty("output_tokens", 456);

        assertNull(UsageCostCalculator.calculateTurnCostUsd("claude", usage, "custom-claude-without-pricing"));
        assertNull(UsageCostCalculator.calculateTurnCostUsd("codex", usage, "custom-codex-without-pricing"));
        assertNull(UsageCostCalculator.calculateTurnCostUsd("codex", usage, null));
    }
}

package com.github.claudecodegui.util;

import com.github.claudecodegui.provider.grok.GrokContextUsageBuilder;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for provider-aware token extraction and context-snapshot lifecycle.
 */
public class TokenUsageUtilsTest {

    /**
     * Verifies Claude context usage includes all input-side cache categories but excludes output.
     */
    @Test
    public void contextTokensExcludeOutputTokens() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 180000);
        usage.addProperty("cache_creation_input_tokens", 12000);
        usage.addProperty("cache_read_input_tokens", 160000);
        usage.addProperty("output_tokens", 2400);

        assertEquals(352000, TokenUsageUtils.extractContextTokens(usage, "claude"));
    }

    /**
     * Verifies Codex context usage uses the provider's cache-inclusive input count only.
     */
    @Test
    public void codexContextTokensUseInputOnly() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 180000);
        usage.addProperty("output_tokens", 2400);
        usage.addProperty("cached_input_tokens", 160000);

        assertEquals(180000, TokenUsageUtils.extractContextTokens(usage, "codex"));
    }

    /**
     * Verifies Codex lookup prefers the root current-context snapshot over nested historical usage.
     */
    @Test
    public void codexPrefersTopLevelContextUsageOverNestedHistoricalUsage() {
        JsonObject nestedUsage = new JsonObject();
        nestedUsage.addProperty("input_tokens", 22496533);
        JsonObject message = new JsonObject();
        message.add("usage", nestedUsage);

        JsonObject currentUsage = new JsonObject();
        currentUsage.addProperty("input_tokens", 127886);
        JsonObject raw = new JsonObject();
        raw.add("message", message);
        raw.add("usage", currentUsage);

        ClaudeSession.Message assistant = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT,
                "",
                raw
        );

        assertEquals(
                127886,
                TokenUsageUtils.findLastUsageFromSessionMessages(List.of(assistant), "codex")
                        .get("input_tokens").getAsInt()
        );
        assertEquals(
                22496533,
                TokenUsageUtils.findLastUsageFromSessionMessages(List.of(assistant))
                        .get("input_tokens").getAsInt()
        );
    }

    /**
     * Verifies a provider-reported context window overrides static configuration while malformed
     * or missing metadata retains the supplied fallback.
     */
    @Test
    public void extractMaxTokensPrefersTrustedProviderWindow() {
        JsonObject usage = new JsonObject();
        usage.addProperty("model_context_window", 258400);

        assertEquals(258400, TokenUsageUtils.extractMaxTokens(usage, 1_050_000));
        usage.addProperty("model_context_window", -1);
        assertEquals(1_050_000, TokenUsageUtils.extractMaxTokens(usage, 1_050_000));
        assertEquals(0, TokenUsageUtils.extractMaxTokens(null, -1));
    }

    /**
     * Verifies selection changes remove both supported context usage locations without
     * deleting historical per-turn usage or cost metadata.
     */
    @Test
    public void clearContextUsagePreservesTurnAccounting() {
        JsonObject raw = new JsonObject();
        raw.add("usage", usage(12000));
        raw.add("turnUsage", usage(345));
        raw.addProperty("turnCostUsd", 0.42);
        JsonObject nestedMessage = new JsonObject();
        nestedMessage.add("usage", usage(9000));
        raw.add("message", nestedMessage);

        ClaudeSession.Message assistant = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "answer", raw);

        TokenUsageUtils.clearContextUsageFromSessionMessages(List.of(assistant));

        assertFalse(raw.has("usage"));
        assertFalse(nestedMessage.has("usage"));
        assertTrue(raw.has("turnUsage"));
        assertTrue(raw.has("turnCostUsd"));
    }

    /**
     * Verifies grok context and used tokens delegate to GrokContextUsageBuilder and extract
     * accurately from total_tokens-only snapshots.
     */
    @Test
    public void grokExtractContextTokensAndExtractUsedTokensDelegateToGrokBuilder() {
        JsonObject usage = new JsonObject();
        usage.addProperty("total_tokens", 24086);
        assertEquals(24086, TokenUsageUtils.extractContextTokens(usage, "grok"));
        assertEquals(24086, TokenUsageUtils.extractUsedTokens(usage, "grok"));
    }

    /**
     * Verifies grok context tokens count cached input exactly once when no total is reported:
     * Claude-style input_tokens excludes cache_read_input_tokens, camelCase inputTokens includes cachedReadTokens.
     */
    @Test
    public void grokContextTokensDoNotDoubleCountCacheReadTokens() {
        JsonObject claudeStyle = new JsonObject();
        claudeStyle.addProperty("input_tokens", 554);
        claudeStyle.addProperty("cache_read_input_tokens", 23168);
        claudeStyle.addProperty("output_tokens", 356);
        assertEquals(24078, TokenUsageUtils.extractContextTokens(claudeStyle, "grok"));
        assertEquals(24078, TokenUsageUtils.extractUsedTokens(claudeStyle, "grok"));

        JsonObject camelCase = new JsonObject();
        camelCase.addProperty("inputTokens", 23722);
        camelCase.addProperty("cachedReadTokens", 23168);
        camelCase.addProperty("outputTokens", 356);
        assertEquals(24078, TokenUsageUtils.extractContextTokens(camelCase, "grok"));
        assertEquals(24078, TokenUsageUtils.extractUsedTokens(camelCase, "grok"));

        // Reasoning is part of output (totalTokens = inputTokens + outputTokens), so it is not added again.
        JsonObject withReasoning = new JsonObject();
        withReasoning.addProperty("inputTokens", 46915);
        withReasoning.addProperty("cachedReadTokens", 24960);
        withReasoning.addProperty("outputTokens", 415);
        withReasoning.addProperty("reasoningTokens", 361);
        assertEquals(47330, TokenUsageUtils.extractContextTokens(withReasoning, "grok"));
        assertEquals(47330, GrokContextUsageBuilder.normalizeTurnUsage(withReasoning).get("total_tokens").getAsInt());
    }

    /**
     * Verifies normalized snapshots keep cache-inclusive input so whole-turn usage can split it again,
     * even when the reported total is not exactly input plus output.
     */
    @Test
    public void grokNormalizedSnapshotKeepsCacheInclusiveInput() {
        JsonObject step = new JsonObject();
        step.addProperty("input_tokens", 554);
        step.addProperty("cache_read_input_tokens", 23168);
        step.addProperty("output_tokens", 356);
        step.addProperty("total_tokens", 24086);

        JsonObject snapshot = GrokContextUsageBuilder.normalizeUsageToSnakeCase(step);
        assertEquals(23722, snapshot.get("input_tokens").getAsInt());
        assertEquals(23168, snapshot.get("cached_read_tokens").getAsInt());

        JsonObject turn = GrokContextUsageBuilder.normalizeTurnUsage(snapshot);
        assertEquals(554, turn.get("input_tokens").getAsInt());
        assertEquals(23168, turn.get("cache_read_input_tokens").getAsInt());
        assertEquals(24086, turn.get("total_tokens").getAsInt());
    }

    /**
     * Verifies GrokContextUsageBuilder normalizes whole-turn Grok usage into the canonical Claude schema.
     */
    @Test
    public void grokContextUsageBuilderNormalizesTurnUsageToClaudeSchema() throws Exception {
        JsonObject raw = new JsonObject();
        raw.addProperty("inputTokens", 46915);
        raw.addProperty("cachedReadTokens", 24960);
        raw.addProperty("outputTokens", 415);
        raw.addProperty("reasoningTokens", 361);
        raw.addProperty("totalTokens", 47330);

        JsonObject normalized;
        try {
            java.lang.reflect.Method m = Class.forName("com.github.claudecodegui.provider.grok.GrokContextUsageBuilder")
                    .getMethod("normalizeTurnUsage", JsonObject.class);
            normalized = (JsonObject) m.invoke(null, raw);
        } catch (NoSuchMethodException e) {
            throw new AssertionError("GrokContextUsageBuilder.normalizeTurnUsage is not implemented yet", e);
        }

        assertEquals(21955, normalized.get("input_tokens").getAsInt());
        assertEquals(24960, normalized.get("cache_read_input_tokens").getAsInt());
        assertEquals(0, normalized.get("cache_creation_input_tokens").getAsInt());
        assertEquals(415, normalized.get("output_tokens").getAsInt());
        assertEquals(361, normalized.get("thinking_tokens").getAsInt());
        assertEquals(47330, normalized.get("total_tokens").getAsInt());
    }

    private static JsonObject usage(int inputTokens) {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", inputTokens);
        return usage;
    }
}

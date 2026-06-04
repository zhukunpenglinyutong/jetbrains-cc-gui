package com.github.claudecodegui.util;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class TokenUsageUtilsTest {

    @Test
    public void buildUsageUpdatePayloadIncludesDetailedClaudeTokenBreakdown() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 1200);
        usage.addProperty("output_tokens", 340);
        usage.addProperty("cache_creation_input_tokens", 80);
        usage.addProperty("cache_read_input_tokens", 600);

        JsonObject payload = TokenUsageUtils.buildUsageUpdatePayload(usage, "claude", 5000);

        assertEquals(2220, payload.get("usedTokens").getAsInt());
        assertEquals(5000, payload.get("maxTokens").getAsInt());
        assertEquals(1200, payload.get("inputTokens").getAsInt());
        assertEquals(340, payload.get("outputTokens").getAsInt());
        assertEquals(80, payload.get("cacheCreationTokens").getAsInt());
        assertEquals(600, payload.get("cacheReadTokens").getAsInt());
        assertEquals(44.4, payload.get("percentage").getAsDouble(), 0.001);
    }

    @Test
    public void buildUsageUpdatePayloadUsesCodexInputPlusOutputButKeepsCachedInputDetail() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 1800);
        usage.addProperty("output_tokens", 200);
        usage.addProperty("cache_read_input_tokens", 700);
        usage.addProperty("cache_creation_input_tokens", 0);

        JsonObject payload = TokenUsageUtils.buildUsageUpdatePayload(usage, "codex", 10000);

        assertEquals(2000, payload.get("usedTokens").getAsInt());
        assertEquals(1800, payload.get("inputTokens").getAsInt());
        assertEquals(200, payload.get("outputTokens").getAsInt());
        assertEquals(0, payload.get("cacheCreationTokens").getAsInt());
        assertEquals(700, payload.get("cacheReadTokens").getAsInt());
        assertEquals(20.0, payload.get("percentage").getAsDouble(), 0.001);
    }
}

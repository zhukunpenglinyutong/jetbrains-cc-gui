package com.github.claudecodegui.handler;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for pure helpers on {@link PromptEnhancerHandler}:
 * dynamic timeout sizing and CONTENT_DELTA JSON payload parsing.
 */
public class PromptEnhancerHandlerTimeoutTest {

    @Test
    public void computeEnhanceTimeoutSeconds_shortPromptUsesBase() {
        assertEquals(45L, PromptEnhancerHandler.computeEnhanceTimeoutSeconds(0));
        assertEquals(45L, PromptEnhancerHandler.computeEnhanceTimeoutSeconds(399));
    }

    @Test
    public void computeEnhanceTimeoutSeconds_growsWithLengthThenCaps() {
        // 400 chars => +1s
        assertEquals(46L, PromptEnhancerHandler.computeEnhanceTimeoutSeconds(400));
        // 40_000 chars => +100s => would be 145, capped at 120
        assertEquals(120L, PromptEnhancerHandler.computeEnhanceTimeoutSeconds(40_000));
    }

    @Test
    public void parseJsonStringPayload_decodesJsonString() {
        assertEquals("Hello\nWorld", PromptEnhancerHandler.parseJsonStringPayload("\"Hello\\nWorld\""));
        assertEquals("plain", PromptEnhancerHandler.parseJsonStringPayload("plain"));
        assertNull(PromptEnhancerHandler.parseJsonStringPayload(""));
        assertNull(PromptEnhancerHandler.parseJsonStringPayload(null));
    }

    @Test
    public void buildUsageMeta_extractsProviderModelAndMode() {
        JsonObject config = new JsonObject();
        config.addProperty("effectiveProvider", "claude");
        config.addProperty("resolutionSource", "manual");
        JsonObject models = new JsonObject();
        models.addProperty("claude", "claude-sonnet-4-6");
        models.addProperty("codex", "gpt-5.5");
        config.add("models", models);

        JsonObject meta = PromptEnhancerHandler.buildUsageMeta(config);
        assertEquals("claude", meta.get("provider").getAsString());
        assertEquals("claude-sonnet-4-6", meta.get("model").getAsString());
        assertEquals("manual", meta.get("resolutionSource").getAsString());
    }

    @Test
    public void buildUsageMeta_nullConfigIsUnavailable() {
        JsonObject meta = PromptEnhancerHandler.buildUsageMeta(null);
        assertEquals("unavailable", meta.get("resolutionSource").getAsString());
        assertFalse(meta.has("provider"));
        assertFalse(meta.has("model"));
    }

    @Test
    public void buildUsageMeta_autoModeWithoutProviderOmitsProvider() {
        JsonObject config = new JsonObject();
        config.addProperty("resolutionSource", "auto");
        JsonObject meta = PromptEnhancerHandler.buildUsageMeta(config);
        assertEquals("auto", meta.get("resolutionSource").getAsString());
        assertFalse(meta.has("provider"));
        assertTrue(meta.has("resolutionSource"));
    }

    @Test
    public void buildUsageMeta_autoModeFollowsChatModelWhenProviderMatches() {
        JsonObject config = new JsonObject();
        config.addProperty("effectiveProvider", "opencode");
        config.addProperty("resolutionSource", "auto");
        JsonObject models = new JsonObject();
        models.addProperty("opencode", "opencode-default");
        config.add("models", models);

        JsonObject meta = PromptEnhancerHandler.buildUsageMeta(
                config, "opencode", "opencode/deepseek-v4-flash-free");
        assertEquals("opencode", meta.get("provider").getAsString());
        assertEquals("opencode/deepseek-v4-flash-free", meta.get("model").getAsString());
        assertEquals("auto", meta.get("resolutionSource").getAsString());
    }

    @Test
    public void buildUsageMeta_manualModeKeepsConfiguredModel() {
        JsonObject config = new JsonObject();
        config.addProperty("effectiveProvider", "opencode");
        config.addProperty("resolutionSource", "manual");
        JsonObject models = new JsonObject();
        models.addProperty("opencode", "opencode-default");
        config.add("models", models);

        JsonObject meta = PromptEnhancerHandler.buildUsageMeta(
                config, "opencode", "opencode/deepseek-v4-flash-free");
        assertEquals("opencode-default", meta.get("model").getAsString());
    }

    @Test
    public void buildUsageMeta_autoModeIgnoresChatModelWhenProviderDiffers() {
        JsonObject config = new JsonObject();
        config.addProperty("effectiveProvider", "claude");
        config.addProperty("resolutionSource", "auto");
        JsonObject models = new JsonObject();
        models.addProperty("claude", "claude-sonnet-4-6");
        config.add("models", models);

        JsonObject meta = PromptEnhancerHandler.buildUsageMeta(
                config, "opencode", "opencode/deepseek-v4-flash-free");
        assertEquals("claude-sonnet-4-6", meta.get("model").getAsString());
    }
}

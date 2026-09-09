package com.github.claudecodegui.handler.provider.gemini;

import org.junit.Test;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

/**
 * Contract-pins the plan-usage bridge wiring (review M1): the dispatch type the
 * webview polls and the JS callback the snapshot is pushed through are string
 * contracts across the Java/webview boundary — a rename or typo would silently
 * kill the indicator while both suites stay green. Precedent:
 * {@link CodexMcpServerHandlerCallbackTest}.
 */
public class GeminiPlanUsageHandlerCallbackTest {

    @Test
    public void geminiPlanUsagePushesThroughTheContractedJsCallback() {
        assertEquals(
                "window.updateGeminiPlanUsage",
                GeminiPlanUsageHandler.GEMINI_PLAN_USAGE_CALLBACK);
    }

    @Test
    public void geminiPlanUsageDispatchTypeMatchesTheWebviewPollCommand() {
        assertEquals("get_gemini_plan_usage", GeminiPlanUsageHandler.DISPATCH_TYPE);
        assertArrayEquals(
                "the supported types must expose exactly the contracted dispatch type",
                new String[]{GeminiPlanUsageHandler.DISPATCH_TYPE},
                new GeminiPlanUsageHandler(null).getSupportedTypes());
    }

    @Test
    public void unknownDispatchTypeIsRejectedWithoutTouchingTheContext() {
        assertFalse(new GeminiPlanUsageHandler(null).handle("get_claude_plan_usage", null));
    }
}

package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.Collections;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.*;

/**
 * Comprehensive tests for Grok provider components after persistent ACP + rebase.
 */
public class GrokSDKBridgeTest {

    @Test
    public void testBuildStdinPayloadIncludesGrokFields() {
        GrokSDKBridge bridge = new GrokSDKBridge();
        bridge.setApiKey("test-key");

        JsonObject payload = bridge.buildStdinPayloadForDaemon(
                "hello grok",
                "sess-123",
                "epoch-xyz",
                "/tmp",
                Collections.emptyList(),
                "default",
                "grok-2",
                null,
                "",
                true,
                false,
                null
        );

        assertEquals("hello grok", payload.get("message").getAsString());
        assertEquals("grok-2", payload.get("model").getAsString());
        assertEquals("test-key", payload.get("apiKey").getAsString());
        assertEquals("sess-123", payload.get("sessionId").getAsString());
    }

    @Test
    public void testSetPermissionModeLiveSkipsWhenNoDaemon() {
        GrokSDKBridge bridge = new GrokSDKBridge();

        // No daemon running: best-effort skip (must not throw / hang).
        JsonObject result = bridge.setPermissionModeLive("sess", "ep", "bypassPermissions").join();
        assertNotNull(result);
        assertTrue(result.get("success").getAsBoolean());
        assertFalse(result.get("applied").getAsBoolean());
        assertEquals("no-daemon", result.get("reason").getAsString());
    }

    @Test
    public void getContextUsageSynthesizesFromLastUsageWithoutDaemon() {
        GrokSDKBridge bridge = new GrokSDKBridge();
        bridge.setLastUsedTokensForTest(12_000);

        JsonObject result = bridge.getContextUsage("sess", "/tmp", "grok-2").join();
        assertTrue(result.get("success").getAsBoolean());
        assertEquals(12_000, result.get("totalTokens").getAsInt());
        assertEquals(128_000, result.get("maxTokens").getAsInt()); // grok-2 limit
        assertEquals("grok-2", result.get("model").getAsString());
        assertEquals("grok-synthesized", result.get("source").getAsString());
    }

    @Test
    public void getUsageReturnsStructuredUnavailableWithoutHangingWhenNoDaemon() {
        GrokSDKBridge bridge = new GrokSDKBridge();
        JsonObject result = bridge.getUsage("/tmp").join();
        assertTrue(result.get("success").getAsBoolean());
        assertTrue(result.has("data"));
        assertTrue(result.getAsJsonObject("data").get("unavailable").getAsBoolean());
        assertTrue(result.getAsJsonObject("data").get("message").getAsString().length() > 0);
    }

    @Test
    public void buildUsageUnavailableHasUiShape() {
        JsonObject result = GrokSDKBridge.buildUsageUnavailable("test msg");
        assertTrue(result.get("success").getAsBoolean());
        assertEquals("test msg", result.getAsJsonObject("data").get("message").getAsString());
        assertEquals("plugin-fallback", result.getAsJsonObject("data").get("source").getAsString());
    }

    @Test
    public void testSetPermissionModeLiveAcceptsDefaultAndBypassModesWithoutThrowing() {
        GrokSDKBridge bridge = new GrokSDKBridge();

        JsonObject defaultResult = bridge.setPermissionModeLive("s", "e", "default").join();
        assertTrue(defaultResult.get("success").getAsBoolean());
        assertEquals("no-daemon", defaultResult.get("reason").getAsString());

        JsonObject autoResult = bridge.setPermissionModeLive("s", "e", "bypassPermissions").join();
        assertTrue(autoResult.get("success").getAsBoolean());
        assertFalse(autoResult.get("applied").getAsBoolean());
    }

    @Test
    public void testResetAndPrewarmMethodsDoNotThrow() {
        GrokSDKBridge bridge = new GrokSDKBridge();

        // These should be no-op or safe when no daemon
        try {
            bridge.resetPersistentRuntime("some-epoch");
            bridge.prewarmDaemonAsync("/tmp", "ep-1");
            bridge.prewarmDaemonAsync("/tmp", "ep-2", "sess-xyz");
        } catch (Exception e) {
            throw new AssertionError("Should not throw", e);
        }
    }

    @Test
    public void grokMessageHandlerUsageUsesRealContextLimit() {
        // The fix ensures GrokMessageHandler calls getModelContextLimit instead of hardcoding 0.
        // We verify the model limit helper works for Grok names.
        int limit = com.github.claudecodegui.handler.provider.ModelProviderHandler.getModelContextLimit("grok-2");
        assertTrue(limit > 0);
        assertEquals(128000, limit);
    }

    @Test
    public void testGrokModelsHaveExpectedContextLimits() {
        assertEquals(500000, com.github.claudecodegui.handler.provider.ModelProviderHandler.getModelContextLimit("grok"));
        assertEquals(128000, com.github.claudecodegui.handler.provider.ModelProviderHandler.getModelContextLimit("grok-2"));
        assertEquals(500000, com.github.claudecodegui.handler.provider.ModelProviderHandler.getModelContextLimit("grok-4.6"));
        assertEquals(500000, com.github.claudecodegui.handler.provider.ModelProviderHandler.getModelContextLimit("grok-build"));
    }

    @Test
    public void testCreatePlanUsageCallbackReadsResultAndIgnoresLines() {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        com.github.claudecodegui.provider.common.DaemonBridge.DaemonOutputCallback callback =
                GrokSDKBridge.createPlanUsageCallback(future);

        // onLine should be ignored even if it looks like a usage payload
        callback.onLine("{\"present\":false,\"message\":\"fake line\"}");

        // onResult carries the real payload from the pre-queue handler
        JsonObject payload = new JsonObject();
        payload.addProperty("present", true);
        payload.addProperty("capacity_pct", 75.0);

        JsonObject response = new JsonObject();
        response.addProperty("id", "123");
        response.addProperty("done", true);
        response.addProperty("success", true);
        response.add("result", payload);

        callback.onResult(response);
        callback.onComplete(true);

        assertTrue(future.isDone());
        JsonObject actual = future.join();
        assertNotNull(actual);
        assertTrue(actual.get("present").getAsBoolean());
        assertEquals(75.0, actual.get("capacity_pct").getAsDouble(), 0.001);
    }

    @Test
    public void testCreatePlanUsageCallbackIgnoresLineOnlyAndFailsGracefully() {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        com.github.claudecodegui.provider.common.DaemonBridge.DaemonOutputCallback callback =
                GrokSDKBridge.createPlanUsageCallback(future);

        // Only onLine is invoked, no onResult
        callback.onLine("{\"present\":true,\"capacity_pct\":99.0}");
        callback.onComplete(true);

        assertTrue(future.isDone());
        JsonObject actual = future.join();
        assertNotNull(actual);
        assertFalse(actual.get("present").getAsBoolean());
        assertTrue(actual.get("unavailable").getAsBoolean());
    }

    @Test
    public void testGetPlanUsageReturnsUnavailableWhenNoDaemon() {
        GrokSDKBridge bridge = new GrokSDKBridge();
        JsonObject result = bridge.getPlanUsage("/tmp", null).join();
        assertNotNull(result);
        assertFalse(result.get("present").getAsBoolean());
        assertTrue(result.get("unavailable").getAsBoolean());
        assertEquals("grok", result.get("provider").getAsString());
        assertEquals("x.ai/billing", result.get("source").getAsString());
        assertEquals("Grok daemon is not running", result.get("message").getAsString());
        assertTrue(result.get("dormant").getAsBoolean());
    }

    @Test
    public void testGetPlanUsageNeverStartsTheDaemon() {
        GrokSDKBridge bridge = new GrokSDKBridge();
        JsonObject result = bridge.getPlanUsage("/tmp").join();
        assertNotNull(result);
        assertFalse(result.get("present").getAsBoolean());
        // api_key auth skips; any other auth finds no running daemon. Neither starts one.
        assertTrue(result.has("skipPolling") || result.get("dormant").getAsBoolean());
        assertNull(bridge.getCurrentDaemonBridgeForInspection());
    }

    @Test
    public void testCreatePlanUsageCallbackHandlesOnErrorAndNonBooleanPresent() {
        CompletableFuture<JsonObject> errorFuture = new CompletableFuture<>();
        com.github.claudecodegui.provider.common.DaemonBridge.DaemonOutputCallback errorCallback =
                GrokSDKBridge.createPlanUsageCallback(errorFuture);

        errorCallback.onError("billing rpc failed");
        errorCallback.onComplete(false);

        assertTrue(errorFuture.isDone());
        JsonObject errorResult = errorFuture.join();
        assertFalse(errorResult.get("present").getAsBoolean());
        assertTrue(errorResult.get("unavailable").getAsBoolean());
        assertEquals("billing rpc failed", errorResult.get("message").getAsString());

        // Non-boolean 'present' (e.g. JsonNull or string) must be rejected
        CompletableFuture<JsonObject> malformedFuture = new CompletableFuture<>();
        com.github.claudecodegui.provider.common.DaemonBridge.DaemonOutputCallback malformedCallback =
                GrokSDKBridge.createPlanUsageCallback(malformedFuture);

        JsonObject badPayload = new JsonObject();
        badPayload.add("present", com.google.gson.JsonNull.INSTANCE);
        JsonObject response = new JsonObject();
        response.add("result", badPayload);

        malformedCallback.onResult(response);
        malformedCallback.onComplete(true);

        JsonObject malformedResult = malformedFuture.join();
        assertFalse(malformedResult.get("present").getAsBoolean());
        assertTrue(malformedResult.get("unavailable").getAsBoolean());
    }

    @Test
    public void testSkipsPlanUsagePoll() {
        assertTrue(GrokSDKBridge.skipsPlanUsagePoll("api_key"));
        assertFalse(GrokSDKBridge.skipsPlanUsagePoll("oauth"));
        assertFalse(GrokSDKBridge.skipsPlanUsagePoll("auto"));
        assertFalse(GrokSDKBridge.skipsPlanUsagePoll(null));
        assertFalse(GrokSDKBridge.skipsPlanUsagePoll(""));
    }

    @Test
    public void testPlanUsageApiKeySkip() {
        JsonObject result = GrokSDKBridge.planUsageApiKeySkip();
        assertNotNull(result);
        assertFalse(result.get("present").getAsBoolean());
        assertTrue(result.get("unavailable").getAsBoolean());
        assertTrue(result.get("skipPolling").getAsBoolean());
        assertEquals("grok", result.get("provider").getAsString());
        assertEquals("x.ai/billing", result.get("source").getAsString());
        assertEquals("Grok usage unavailable", result.get("message").getAsString());
    }
}

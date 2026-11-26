package com.github.claudecodegui.handler.provider.gemini;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Checks request identity and lifecycle-bound delivery across the Java/webview bridge. */
public class GeminiPlanUsageHandlerCallbackTest {

    private final List<String> scripts = new ArrayList<>();
    private final CompletableFuture<JsonObject> probe = new CompletableFuture<>();
    private int requests;
    private int page;
    private HandlerContext context;
    private GeminiPlanUsageHandler handler;

    /** Installs a page-scoped callback and an explicitly controlled asynchronous probe. */
    @Before
    public void installBridge() {
        this.context = new HandlerContext(null, null, null, null, new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
                throw new AssertionError("Asynchronous replies must be scoped to the originating page");
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }

            @Override
            public HandlerContext.JsSender captureJavaScriptExecutor() {
                int origin = GeminiPlanUsageHandlerCallbackTest.this.page;
                return script -> origin == GeminiPlanUsageHandlerCallbackTest.this.page
                        && GeminiPlanUsageHandlerCallbackTest.this.scripts.add(script);
            }
        });
        this.handler = new GeminiPlanUsageHandler(this.context, () -> {
            this.requests++;
            return this.probe;
        });
    }

    /** Ensures the completed probe replies using the original request ID. */
    @Test
    public void echoesRequestIdAndQuotaThroughTheContractedCallback() {
        assertArrayEquals(new String[]{"get_gemini_plan_usage"}, this.handler.getSupportedTypes());
        assertTrue(this.handler.handle("get_gemini_plan_usage", "42"));
        assertEquals(1, this.requests);
        assertTrue(this.scripts.isEmpty());
        this.probe.complete(noQuota());
        assertEquals(List.of("window.updateGeminiPlanUsage?.(\"42\", \"{\\\"status\\\":\\\"unavailable\\\",\\\"reasonCode\\\":\\\"no_quota\\\"}\");"), this.scripts);
    }

    /** Rejects old model-slug requests without launching the CLI. */
    @Test
    public void doesNotStartQuotaQueryOnUnknownOrInvalidRequests() {
        assertFalse(this.handler.handle("get_claude_plan_usage", null));
        assertTrue(this.handler.handle("get_gemini_plan_usage", "gemini-3.7-flash-high"));
        assertEquals(0, this.requests);
    }

    /** Page replacement cannot receive a reply for an earlier page. */
    @Test
    public void neverSendsAnOldReplyToANewPage() {
        this.handler.handle("get_gemini_plan_usage", "42");
        this.page++;
        this.probe.complete(noQuota());
        assertTrue(this.scripts.isEmpty());
    }

    /** Disposing the handler prevents both later requests and delivery of pending results. */
    @Test
    public void skipsQuotaQueryAndReplyWhenDisposed() {
        this.handler.handle("get_gemini_plan_usage", "42");
        this.context.setDisposed(true);
        assertTrue(this.handler.handle("get_gemini_plan_usage", "43"));
        this.probe.complete(noQuota());
        assertEquals(1, this.requests);
        assertTrue(this.scripts.isEmpty());
    }

    /** Failed probes expose a stable reason without any diagnostic text. */
    @Test
    public void doesNotExposeTheProbeException() {
        this.handler.handle("get_gemini_plan_usage", "42");
        this.probe.completeExceptionally(new IllegalStateException("sensitive message"));
        assertEquals(1, this.scripts.size());
        assertTrue(this.scripts.get(0).contains("query_failed"));
        assertFalse(this.scripts.get(0).contains("sensitive message"));
    }

    private static JsonObject noQuota() {
        JsonObject quota = new JsonObject();
        quota.addProperty("status", "unavailable");
        quota.addProperty("reasonCode", "no_quota");
        return quota;
    }
}

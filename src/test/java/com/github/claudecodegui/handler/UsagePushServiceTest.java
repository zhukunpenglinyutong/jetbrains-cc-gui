package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;

/**
 * Regression tests for usage-display invalidation across the WebView and IDE status bar.
 */
public class UsagePushServiceTest {

    /**
     * Verifies clearing usage invokes the status-bar side effect and sends a WebView
     * payload that marks usage unknown without fabricating numerator or capacity values.
     */
    @Test
    public void clearUsageDisplayClearsStatusBarAndSendsUnknownWebviewPayload() {
        RecordingUsagePushService service = new RecordingUsagePushService(createContext());

        service.clearUsageDisplay();

        assertEquals(1, service.statusBarClearCount);
        assertEquals(1, service.payloadCount);
        assertNotNull(service.lastPayload);
        assertEquals(0, service.lastPayload.get("percentage").getAsInt());
        assertFalse(service.lastPayload.has("usedTokens"));
        assertFalse(service.lastPayload.has("maxTokens"));
        assertFalse(service.lastPayload.has("totalTokens"));
        assertFalse(service.lastPayload.has("limit"));
    }

    /**
     * Creates a minimal handler context; overridden sinks keep the test independent
     * from a running IntelliJ Application and JCEF browser.
     */
    private static HandlerContext createContext() {
        return new HandlerContext(null, null, null, null, new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
                // No-op: the recording service intercepts the payload before JCEF.
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }
        });
    }

    /**
     * Captures both display consumers invoked by the production clear orchestration.
     */
    private static final class RecordingUsagePushService extends UsagePushService {
        private int statusBarClearCount;
        private int payloadCount;
        private JsonObject lastPayload;

        /**
         * Creates a recorder backed by the supplied minimal handler context.
         */
        private RecordingUsagePushService(HandlerContext context) {
            super(context);
        }

        /**
         * Records the IDE status-bar invalidation side effect.
         */
        @Override
        void clearStatusBarUsage() {
            statusBarClearCount++;
        }

        /**
         * Records the exact payload that would be delivered to the WebView.
         */
        @Override
        void sendUsagePayload(JsonObject usageUpdate) {
            payloadCount++;
            lastPayload = usageUpdate.deepCopy();
        }
    }
}

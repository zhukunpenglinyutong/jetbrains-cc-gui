package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Native history rows must expose the same writer protection as legacy history. */
public class CodexNativeDataHandlerTest {

    @Test
    public void listedThreadsHeldByAnotherWindowAreMarkedBeforeReachingTheWebview() {
        JsonObject response = JsonParser.parseString("{\"data\":[{\"id\":\"foreign\"},{\"id\":\"free\"}]}")
                .getAsJsonObject();
        List<String> published = new ArrayList<>();
        CodexSDKBridge bridge = new CodexSDKBridge() {
            @Override
            public CompletableFuture<JsonObject> readCodexNative(
                    String method, String channelId, String cwd, String threadId, JsonObject params) {
                assertEquals("codex.listThreads", method);
                return CompletableFuture.completedFuture(response);
            }

            @Override
            public boolean hasCodexThreadOwner(String threadId) {
                return "foreign".equals(threadId);
            }

            @Override
            public boolean ownsCodexThread(String threadId) {
                return false;
            }
        };
        try {
            HandlerContext context = new HandlerContext(null, null, bridge, null, new HandlerContext.JsCallback() {
                @Override
                public void callJavaScript(String functionName, String... args) {
                    if ("onCodexNativeData".equals(functionName)) {
                        published.add(args[0]);
                    }
                }

                @Override
                public String escapeJs(String str) {
                    return str;
                }
            });

            assertTrue(new CodexNativeDataHandler(context).handle("codex_native_list_threads", "{\"requestId\":\"r1\"}"));

            assertEquals(1, published.size());
            JsonArray rows = JsonParser.parseString(published.get(0)).getAsJsonObject().getAsJsonArray("data");
            assertTrue(rows.get(0).getAsJsonObject().get("running").getAsBoolean());
            assertTrue(rows.get(0).getAsJsonObject().get("ownedElsewhere").getAsBoolean());
            assertFalse(rows.get(1).getAsJsonObject().get("running").getAsBoolean());
            assertFalse(rows.get(1).getAsJsonObject().has("ownedElsewhere"));
        } finally {
            bridge.cleanupAllProcesses();
        }
    }
}

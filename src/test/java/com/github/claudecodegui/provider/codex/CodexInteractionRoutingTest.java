package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.handler.CodexInteractionHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/** Verifies that delayed control replies keep their original page request identity. */
public class CodexInteractionRoutingTest {
    /** Isolates bridge construction from real conversation files. */
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    /** Delivers two plan completions in reverse order without borrowing the active chat identity. */
    @Test
    public void keepsPlanRequestIdentityWhenCompletionsArriveOutOfOrder() throws Exception {
        PlanBridge bridge = new PlanBridge(this.temporary.getRoot().toPath());
        Responses responses = new Responses();
        CodexInteractionHandler handler = new CodexInteractionHandler(new HandlerContext(null, null, bridge, null, responses));
        handler.handle("execute_codex_plan", request("first-root", "first-request").toString());
        handler.handle("execute_codex_plan", request("second-root", "second-request").toString());
        Map<String, PlanRequest> requests = new HashMap<>();
        for (int index = 0; index < 2; index++) {
            PlanRequest next = bridge.requests.poll(5, TimeUnit.SECONDS);
            assertNotNull(next);
            requests.put(next.threadId(), next);
        }
        JsonObject success = new JsonObject();
        success.addProperty("success", true);
        requests.get("second-root").result().complete(success);
        assertReply(responses.next(), "execute_codex_plan", "second-root", "second-request");
        requests.get("first-root").result().completeExceptionally(new IllegalStateException("fixture failure"));
        JsonObject first = responses.next();
        assertReply(first, "execute_codex_plan", "first-root", "first-request");
        assertTrue(first.get("error").getAsString().contains("fixture failure"));
    }

    /** Keeps early control failures identifiable so their waiting UI can finish. */
    @Test
    public void earlyControlFailuresKeepRequestAndThread() throws Exception {
        Responses responses = new Responses();
        CodexInteractionHandler handler = new CodexInteractionHandler(new HandlerContext(null, null, null, null, responses));
        for (String type : new String[]{"execute_codex_plan", "codex_compact", "codex_review"}) {
            handler.handle(type, request("root", type + "-request").toString());
            JsonObject response = responses.next();
            assertReply(response, type, "root", type + "-request");
            assertTrue(response.has("error"));
        }
    }

    private static JsonObject request(String threadId, String requestId) {
        JsonObject request = new JsonObject();
        request.addProperty("threadId", threadId);
        request.addProperty("requestId", requestId);
        request.addProperty("planItemId", "fixture-plan");
        request.addProperty("planText", "Implement fixture");
        return request;
    }

    private static void assertReply(JsonObject response, String type, String threadId, String requestId) {
        assertNotNull(response);
        assertEquals(type, response.get("requestType").getAsString());
        assertEquals(threadId, response.get("threadId").getAsString());
        assertEquals(requestId, response.get("requestId").getAsString());
    }

    private record PlanRequest(String threadId, CompletableFuture<JsonObject> result) { }

    private static final class PlanBridge extends CodexSDKBridge {
        private final BlockingQueue<PlanRequest> requests = new LinkedBlockingQueue<>();

        private PlanBridge(Path sessions) { super(sessions); }

        /** Holds the native operation until the test supplies its actual outcome. */
        @Override
        public CompletableFuture<JsonObject> executeCodexPlan(String channelId, String cwd, String threadId,
                                                             String planItemId, String planText) {
            CompletableFuture<JsonObject> result = new CompletableFuture<>();
            this.requests.add(new PlanRequest(threadId, result));
            return result;
        }
    }

    private static final class Responses implements HandlerContext.JsCallback {
        private final BlockingQueue<JsonObject> replies = new LinkedBlockingQueue<>();

        /** Captures the actual Java-to-page result envelope. */
        @Override
        public void callJavaScript(String functionName, String... args) {
            assertEquals("onCodexInteractionResponse", functionName);
            this.replies.add(JsonParser.parseString(args[0]).getAsJsonObject());
        }

        /** Keeps the payload unchanged in this non-browser receiver. */
        @Override
        public String escapeJs(String value) { return value; }

        private JsonObject next() throws InterruptedException { return this.replies.poll(5, TimeUnit.SECONDS); }
    }
}

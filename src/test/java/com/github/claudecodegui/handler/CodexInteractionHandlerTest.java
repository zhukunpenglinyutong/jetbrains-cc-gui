package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/** Checks that controls share the frontend's rule of waiting behind live sends. */
public class CodexInteractionHandlerTest {
    /** A request from the previous chat must not claim the restored chat's wait. */
    @Test
    public void rejectsControlsForAThreadThatIsNoLongerSelected() throws Exception {
        for (String type : new String[]{"codex_compact", "codex_review"}) {
            RecordingBridge bridge = new RecordingBridge();
            RecordingJs callbacks = new RecordingJs();
            ClaudeSession session = new ClaudeSession(null, null, bridge, null);
            session.setProvider("codex");
            session.setSessionInfo("restored-thread", "/workspace");
            session.getState().setError("restored-state");
            HandlerContext context = new HandlerContext(null, null, bridge, null, callbacks);
            context.setSession(session);

            new CodexInteractionHandler(context).handle(type,
                    "{\"requestId\":\"control\",\"threadId\":\"old-thread\"}");

            JsonObject response = callbacks.results.poll(5, TimeUnit.SECONDS);
            assertNotNull(response);
            assertTrue(response.has("error"));
            assertEquals(type, response.get("requestType").getAsString());
            assertEquals("control", response.get("requestId").getAsString());
            assertEquals("old-thread", response.get("threadId").getAsString());
            assertEquals(0, bridge.operations.get());
            assertFalse(session.isBusy());
            assertFalse(session.isLoading());
            assertEquals("restored-state", session.getError());
        }
    }

    /** Both long controls must report rejection without releasing a live send. */
    @Test
    public void keepsAnActiveSendInChargeOfItsWait() throws Exception {
        for (String type : new String[]{"codex_compact", "codex_review"}) {
            RecordingBridge bridge = new RecordingBridge();
            RecordingJs callbacks = new RecordingJs();
            ClaudeSession session = new ClaudeSession(null, null, bridge, null);
            session.setProvider("codex");
            session.setSessionInfo("root", "/workspace");
            session.getState().beginTurn();
            HandlerContext context = new HandlerContext(null, null, bridge, null, callbacks);
            context.setSession(session);

            new CodexInteractionHandler(context).handle(type, "{\"requestId\":\"control\"}");

            JsonObject response = callbacks.results.poll(5, TimeUnit.SECONDS);
            assertNotNull(response);
            assertTrue(response.has("error"));
            assertEquals(type, response.get("requestType").getAsString());
            assertEquals("control", response.get("requestId").getAsString());
            assertEquals("root", response.get("threadId").getAsString());
            assertEquals(0, bridge.operations.get());
            assertTrue(session.isBusy());
            assertTrue(session.isLoading());
        }
    }

    /** Restored chats can still run either control before their first send. */
    @Test
    public void waitsForTheNativeTerminalOnAnIdleSession() throws Exception {
        for (String type : new String[]{"codex_compact", "codex_review"}) {
            RecordingBridge bridge = new RecordingBridge(true);
            RecordingJs callbacks = new RecordingJs();
            ClaudeSession session = new ClaudeSession(null, null, bridge, null);
            session.setProvider("codex");
            session.setSessionInfo("root", "/workspace");
            HandlerContext context = new HandlerContext(null, null, bridge, null, callbacks);
            context.setSession(session);

            new CodexInteractionHandler(context).handle(type, "{\"requestId\":\"control\"}");

            assertTrue(bridge.started.await(5, TimeUnit.SECONDS));
            assertTrue(session.isBusy());
            assertTrue(session.isLoading());
            bridge.finish();
            assertNotNull(callbacks.results.poll(5, TimeUnit.SECONDS));
            assertFalse(session.isBusy());
            assertFalse(session.isLoading());
        }
    }

    /** A delayed compact terminal cannot unlock a later submission. */
    @Test
    public void leavesANewerSendAloneWhenTheControlFinishes() throws Exception {
        RecordingBridge bridge = new RecordingBridge(true);
        RecordingJs callbacks = new RecordingJs();
        ClaudeSession session = new ClaudeSession(null, null, bridge, null);
        session.setProvider("codex");
        session.setSessionInfo("root", "/workspace");
        HandlerContext context = new HandlerContext(null, null, bridge, null, callbacks);
        context.setSession(session);

        new CodexInteractionHandler(context).handle("codex_compact", "{\"requestId\":\"control\"}");
        assertTrue(bridge.started.await(5, TimeUnit.SECONDS));
        session.getState().beginTurn();
        session.getState().setError("next-send-state");
        bridge.finish();

        assertNotNull(callbacks.results.poll(5, TimeUnit.SECONDS));
        assertTrue(session.isBusy());
        assertTrue(session.isLoading());
        assertEquals("next-send-state", session.getError());
    }

    private static final class RecordingBridge extends CodexSDKBridge {
        private final AtomicInteger operations = new AtomicInteger();
        private final CountDownLatch started = new CountDownLatch(1);
        private final CompletableFuture<JsonObject> terminal = new CompletableFuture<>();
        private final boolean deferred;
        private volatile MessageCallback callback;

        private RecordingBridge() {
            this(false);
        }

        private RecordingBridge(boolean deferred) {
            this.deferred = deferred;
        }

        /** Completes a fixture operation without starting a daemon. */
        @Override
        public CompletableFuture<JsonObject> compactCodex(String channelId, String cwd, String threadId,
                                                          MessageCallback callback) {
            this.operations.incrementAndGet();
            this.callback = callback;
            this.started.countDown();
            if (!this.deferred) {
                this.finish();
            }
            return this.terminal;
        }

        /** Uses the same terminal for either long control. */
        @Override
        public CompletableFuture<JsonObject> reviewCodex(String channelId, String cwd, String threadId,
                                                         MessageCallback callback) {
            return this.compactCodex(channelId, cwd, threadId, callback);
        }

        private void finish() {
            this.callback.onComplete(new SDKResult());
            JsonObject result = new JsonObject();
            result.addProperty("success", true);
            this.terminal.complete(result);
        }
    }

    private static final class RecordingJs implements HandlerContext.JsCallback {
        private final LinkedBlockingQueue<JsonObject> results = new LinkedBlockingQueue<>();

        /** Captures the page's operation result. */
        @Override
        public void callJavaScript(String functionName, String... args) {
            if ("onCodexInteractionResponse".equals(functionName)) {
                this.results.add(JsonParser.parseString(args[0]).getAsJsonObject());
            }
        }

        /** Keeps fixture payloads readable without a browser. */
        @Override
        public String escapeJs(String value) {
            return value;
        }
    }
}

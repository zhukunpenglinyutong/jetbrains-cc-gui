package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Verifies that the Java app-server executor keeps one daemon request seam across turns. */
public class CodexAppServerRequestExecutorTest {

    /** Keeps interruption distinct from a rejected RPC in compact and review replies. */
    @Test
    public void longOperationRetainsItsNativeStopOutcome() {
        for (String outcome : new String[]{"interrupted", "cancelled"}) {
            DaemonBridge daemon = new DaemonBridge(null, null, null) {
                /** Returns a terminal native stop without a transport failure. */
                @Override
                public CompletableFuture<Boolean> sendCommand(String method, JsonObject params, DaemonOutputCallback callback) {
                    JsonObject nativeResult = new JsonObject();
                    nativeResult.addProperty("outcome", outcome);
                    JsonObject response = new JsonObject();
                    response.add("result", nativeResult);
                    response.addProperty("aborted", true);
                    callback.onResult(response);
                    callback.onComplete(false);
                    return CompletableFuture.completedFuture(false);
                }
            };
            CodexAppServerRequestExecutor executor = new CodexAppServerRequestExecutor(
                    Logger.getInstance(CodexAppServerRequestExecutorTest.class), null);
            JsonObject result = executor.sendLongOperationCommand(daemon, "codex.compact", new JsonObject()).join();
            assertEquals(outcome, result.get("outcome").getAsString());
            assertEquals(false, result.get("success").getAsBoolean());
        }
    }

    /** Compact failures keep the native reason instead of reducing it to a generic failure. */
    @Test
    public void longOperationKeepsTheNativeWriterRejection() {
        DaemonBridge daemon = new DaemonBridge(null, null, null) {
            @Override public CompletableFuture<Boolean> sendCommand(String method, JsonObject params, DaemonOutputCallback callback) {
                callback.onError("thread fixture already has an active writer");
                callback.onComplete(false);
                return CompletableFuture.completedFuture(false);
            }
        };
        CodexAppServerRequestExecutor executor = new CodexAppServerRequestExecutor(
                Logger.getInstance(CodexAppServerRequestExecutorTest.class), null);
        JsonObject result = executor.sendLongOperationCommand(daemon, "codex.compact", new JsonObject()).join();
        assertEquals("thread fixture already has an active writer", result.get("error").getAsString());
    }

    @Test
    public void threeTurnsReuseTheDaemonCommandSurface() {
        RecordingDaemon daemon = new RecordingDaemon();
        AtomicInteger markerCount = new AtomicInteger();
        CodexAppServerRequestExecutor executor = new CodexAppServerRequestExecutor(
                Logger.getInstance(CodexAppServerRequestExecutorTest.class),
                ignored -> markerCount.incrementAndGet());

        for (int index = 0; index < 3; index++) {
            SDKResult result = executor.sendMessageViaDaemon(
                    daemon,
                    new JsonObject(),
                    ignored -> { }).join();
            assertTrue(result.success);
        }

        assertEquals(3, daemon.sendCount.get());
        assertEquals(3, markerCount.get());
    }

    @Test
    public void rejectedControlCommandIsReturnedAsAnError() {
        CodexAppServerRequestExecutor executor = new CodexAppServerRequestExecutor(
                Logger.getInstance(CodexAppServerRequestExecutorTest.class), ignored -> { });
        JsonObject result = executor.sendControlCommand(
                new RejectingDaemon(), "codex.respondInteraction", new JsonObject(), 1000L);

        assertTrue(result.has("error"));
    }

    @Test
    public void timedOutControlCommandStillCarriesAnErrorMessage() {
        CodexAppServerRequestExecutor executor = new CodexAppServerRequestExecutor(
                Logger.getInstance(CodexAppServerRequestExecutorTest.class), ignored -> { });
        DaemonBridge silentDaemon = new DaemonBridge(null, null, null) {
            @Override
            public CompletableFuture<Boolean> sendCommand(String method, JsonObject params, DaemonOutputCallback callback) {
                return new CompletableFuture<>();
            }
        };

        JsonObject result = executor.sendControlCommand(silentDaemon, "codex.respondInteraction", new JsonObject(), 10L);

        // A null message becomes JsonNull, which Gson drops when the ack is sent
        // to the page, so the failure would read as a success there.
        assertTrue(result.has("error"));
        assertTrue(result.get("error").isJsonPrimitive());
        assertTrue(result.get("error").getAsString().contains("codex.respondInteraction"));
    }

    @Test
    public void anAnswerCodexNoLongerAwaitsIsNotOfferedAgain() {
        CodexAppServerRequestExecutor executor = new CodexAppServerRequestExecutor(
                Logger.getInstance(CodexAppServerRequestExecutorTest.class), ignored -> { });

        JsonObject result = executor.sendControlCommand(
                new FailingDaemon("Codex is no longer waiting for this answer", "INTERACTION_NOT_PENDING"),
                "codex.respondInteraction", new JsonObject(), 1000L);

        assertEquals("Codex is no longer waiting for this answer", result.get("error").getAsString());
        assertEquals(false, result.get("retryable").getAsBoolean());
        assertEquals("INTERACTION_NOT_PENDING", result.get("code").getAsString());
        assertFalse(result.has("deliveryUnconfirmed"));
    }

    @Test
    public void onlyAnswersAreFlaggedAsUnconfirmedWhenTheDaemonIsSlow() {
        CodexAppServerRequestExecutor executor = new CodexAppServerRequestExecutor(
                Logger.getInstance(CodexAppServerRequestExecutorTest.class), ignored -> { });
        DaemonBridge slowDaemon = new DaemonBridge(null, null, null) {
            @Override
            public CompletableFuture<Boolean> sendCommand(String method, JsonObject params, DaemonOutputCallback callback) {
                return new CompletableFuture<>();
            }
        };

        JsonObject abort = executor.sendControlCommand(slowDaemon, "codex.abortTurn", new JsonObject(), 10L);
        JsonObject rejection = executor.sendControlCommand(
                slowDaemon, "codex.respondInteractionError", new JsonObject(), 10L);

        assertTrue(abort.has("error"));
        assertFalse(abort.has("retryable"));
        assertFalse(abort.has("deliveryUnconfirmed"));
        assertEquals(true, rejection.get("deliveryUnconfirmed").getAsBoolean());
    }

    @Test
    public void aCorrectableRejectionStaysRetryable() {
        CodexAppServerRequestExecutor executor = new CodexAppServerRequestExecutor(
                Logger.getInstance(CodexAppServerRequestExecutorTest.class), ignored -> { });

        JsonObject result = executor.sendControlCommand(
                new FailingDaemon("invalid native Codex interaction result", "INVALID_INTERACTION_RESULT"),
                "codex.respondInteraction", new JsonObject(), 1000L);

        assertEquals("invalid native Codex interaction result", result.get("error").getAsString());
        assertFalse(result.has("retryable"));
    }

    @Test
    public void aTimedOutAnswerIsUnconfirmedRatherThanLost() {
        CodexAppServerRequestExecutor executor = new CodexAppServerRequestExecutor(
                Logger.getInstance(CodexAppServerRequestExecutorTest.class), ignored -> { });
        DaemonBridge slowDaemon = new DaemonBridge(null, null, null) {
            @Override
            public CompletableFuture<Boolean> sendCommand(String method, JsonObject params, DaemonOutputCallback callback) {
                return new CompletableFuture<>();
            }
        };

        JsonObject result = executor.sendControlCommand(slowDaemon, "codex.respondInteraction", new JsonObject(), 10L);

        // The daemon may still deliver it: asking again could send a second, different answer.
        assertEquals(false, result.get("retryable").getAsBoolean());
        assertEquals(true, result.get("deliveryUnconfirmed").getAsBoolean());
    }

    @Test
    public void reviewAndCompactMarkersReachTheChatConsumer() {
        RecordingDaemon daemon = new RecordingDaemon();
        AtomicInteger markers = new AtomicInteger();
        CodexAppServerRequestExecutor executor = new CodexAppServerRequestExecutor(
                Logger.getInstance(CodexAppServerRequestExecutorTest.class), null);
        executor.sendLongOperationCommand(daemon, "codex.review", new JsonObject(),
                ignored -> markers.incrementAndGet()).join();
        assertEquals(1, markers.get());
    }

    /** Keeps the user message separate from a copied native context snapshot. */
    @Test
    public void sendParamsCarryNativeSettingsWithoutInternalMetadata() {
        JsonObject nativeSettings = new JsonObject();
        nativeSettings.addProperty("collaborationMode", "plan");
        nativeSettings.addProperty("approvalPreset", "request");
        nativeSettings.addProperty("sandboxSelection", "workspace-write");
        nativeSettings.addProperty("sandboxSource", "user");
        nativeSettings.addProperty("revision", 42);
        JsonObject additionalContext = new JsonObject();
        JsonObject editor = new JsonObject();
        editor.addProperty("kind", "application");
        editor.addProperty("value", "Active file: src/Editor.java");
        additionalContext.add("ide_context", editor);
        nativeSettings.add("additionalContext", additionalContext);

        JsonObject params = CodexAppServerRequestExecutor.buildSendParams(
                "channel", "epoch", "client", "task", "thread", "C:/repo",
                "plan", "gpt-test", "high", null, null,
                nativeSettings);

        assertEquals("plan", params.get("collaborationMode").getAsString());
        assertEquals("request", params.get("approvalPreset").getAsString());
        assertEquals("workspace-write", params.get("sandboxSelection").getAsString());
        assertEquals("task", params.get("message").getAsString());
        assertEquals(additionalContext, params.getAsJsonObject("additionalContext"));
        editor.addProperty("value", "changed after enqueue");
        assertEquals("Active file: src/Editor.java",
                params.getAsJsonObject("additionalContext").getAsJsonObject("ide_context").get("value").getAsString());
        assertTrue(!params.has("sandboxSource"));
        assertTrue(!params.has("revision"));
        // Managed credentials are resolved daemon-side; they never travel per request.
        assertTrue(!params.has("apiKey"));
        assertTrue(!params.has("baseUrl"));
    }

    private static final class RecordingDaemon extends DaemonBridge {
        private final AtomicInteger sendCount = new AtomicInteger();

        private RecordingDaemon() {
            super(null, null, null);
        }

        @Override
        public boolean isAlive() {
            return true;
        }

        @Override
        public CompletableFuture<Boolean> sendCommand(
                String method,
                JsonObject params,
                DaemonOutputCallback callback
        ) {
            assertTrue(method.startsWith("codex."));
            sendCount.incrementAndGet();
            callback.onLine("[MESSAGE_START]");
            callback.onComplete(true);
            return CompletableFuture.completedFuture(true);
        }
    }

    /** Reports a failed command the way DaemonBridge does: done line, then onError. */
    private static final class FailingDaemon extends DaemonBridge {
        private final String error;
        private final String code;

        private FailingDaemon(String error, String code) {
            super(null, null, null);
            this.error = error;
            this.code = code;
        }

        @Override
        public CompletableFuture<Boolean> sendCommand(String method, JsonObject params, DaemonOutputCallback callback) {
            JsonObject done = new JsonObject();
            done.addProperty("done", true);
            done.addProperty("success", false);
            done.addProperty("error", error);
            done.addProperty("code", code);
            callback.onResult(done);
            callback.onError(error);
            return CompletableFuture.failedFuture(new RuntimeException(error));
        }
    }

    private static final class RejectingDaemon extends DaemonBridge {

        private RejectingDaemon() {
            super(null, null, null);
        }

        @Override
        public boolean isAlive() {
            return true;
        }

        @Override
        public CompletableFuture<Boolean> sendCommand(
                String method,
                JsonObject params,
                DaemonOutputCallback callback
        ) {
            callback.onComplete(false);
            return CompletableFuture.completedFuture(false);
        }
    }
}

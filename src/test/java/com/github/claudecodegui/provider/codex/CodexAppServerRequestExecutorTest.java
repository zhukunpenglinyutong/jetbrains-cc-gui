package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
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
    public void reviewAndCompactMarkersReachTheChatConsumer() {
        RecordingDaemon daemon = new RecordingDaemon();
        AtomicInteger markers = new AtomicInteger();
        CodexAppServerRequestExecutor executor = new CodexAppServerRequestExecutor(
                Logger.getInstance(CodexAppServerRequestExecutorTest.class), null);
        executor.sendLongOperationCommand(daemon, "codex.review", new JsonObject(),
                ignored -> markers.incrementAndGet()).join();
        assertEquals(1, markers.get());
    }

    @Test
    public void sendParamsCarryNativeSettingsWithoutInternalMetadata() {
        JsonObject nativeSettings = new JsonObject();
        nativeSettings.addProperty("collaborationMode", "plan");
        nativeSettings.addProperty("approvalPreset", "request");
        nativeSettings.addProperty("sandboxSelection", "workspace-write");
        nativeSettings.addProperty("sandboxSource", "user");
        nativeSettings.addProperty("revision", 42);

        JsonObject params = CodexAppServerRequestExecutor.buildSendParams(
                "channel", "epoch", "client", "task", "thread", "C:/repo",
                "plan", "gpt-test", "high", null, null,
                nativeSettings);

        assertEquals("plan", params.get("collaborationMode").getAsString());
        assertEquals("request", params.get("approvalPreset").getAsString());
        assertEquals("workspace-write", params.get("sandboxSelection").getAsString());
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

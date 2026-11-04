package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class GrokDaemonRequestExecutorTest {
    @Test
    public void stoppedRequestReportsCancellationThroughCompletion() throws Exception {
        RecordingCallback callback = new RecordingCallback();

        SDKResult result = send(new AbortingDaemonBridge(false, false), callback);

        assertFalse(result.success);
        assertTrue(result.cancelled);
        assertEquals("User interrupted", result.error);
        assertEquals(1, callback.completions.size());
        assertTrue(callback.errors.isEmpty());
    }

    @Test
    public void sendErrorBeforeStopStillReportsCancellation() throws Exception {
        RecordingCallback callback = new RecordingCallback();

        SDKResult result = send(new AbortingDaemonBridge(false, true), callback);

        assertFalse(result.success);
        assertTrue(result.cancelled);
        assertFalse(callback.errors.isEmpty());
    }

    @Test
    public void failedFutureAfterStopStillReportsCancellation() throws Exception {
        RecordingCallback callback = new RecordingCallback();

        SDKResult result = send(new AbortingDaemonBridge(true, false), callback);

        assertFalse(result.success);
        assertTrue(result.cancelled);
    }

    private static SDKResult send(DaemonBridge daemon, MessageCallback callback) throws Exception {
        GrokDaemonRequestExecutor executor = new GrokDaemonRequestExecutor(
                Logger.getInstance(GrokDaemonRequestExecutor.class), new GrokSDKBridge());
        return executor.sendMessageViaDaemon(daemon, "channel-1", "hello", null, "epoch-1", "/tmp",
                Collections.emptyList(), "default", null, null, "", true, false, null, callback)
                .get(5, TimeUnit.SECONDS);
    }

    private static final class RecordingCallback implements MessageCallback {
        private final List<SDKResult> completions = new ArrayList<>();
        private final List<String> errors = new ArrayList<>();

        @Override
        public void onMessage(String type, String content) {
        }

        @Override
        public void onError(String error) {
            errors.add(error);
        }

        @Override
        public void onComplete(SDKResult result) {
            completions.add(result);
        }
    }

    private static final class AbortingDaemonBridge extends DaemonBridge {
        private final boolean exceptionalCompletion;
        private final boolean errorBeforeAbort;

        private AbortingDaemonBridge(boolean exceptionalCompletion, boolean errorBeforeAbort) {
            super(null, null, null);
            this.exceptionalCompletion = exceptionalCompletion;
            this.errorBeforeAbort = errorBeforeAbort;
        }

        @Override
        public CompletableFuture<Boolean> sendCommand(String method, JsonObject params, DaemonOutputCallback callback) {
            if (errorBeforeAbort) {
                callback.onLine("[SEND_ERROR] {\"error\":\"Transport failed before abort\"}");
            }
            callback.onAbort();
            if (exceptionalCompletion) {
                return CompletableFuture.failedFuture(new IllegalStateException("Transport closed after abort"));
            }
            return CompletableFuture.completedFuture(false);
        }

        @Override
        public boolean isAlive() {
            return true;
        }
    }
}

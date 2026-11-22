package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.DaemonBridge;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import org.junit.Test;
import java.util.concurrent.CompletableFuture;
import static org.junit.Assert.*;

public class CodexReadOnlyTimeoutTest {
    @Test
    public void lightweightStatusDeadlineDoesNotShortenFullTranscripts() {
        JsonObject params = new JsonObject();
        params.addProperty("includeHistory", false);
        assertEquals(8_000L, CodexSDKBridge.readOnlyTimeoutMillis("codex.readSubagent", params));
        params.addProperty("includeHistory", true);
        assertEquals(120_000L, CodexSDKBridge.readOnlyTimeoutMillis("codex.readSubagent", params));
        assertEquals(120_000L, CodexSDKBridge.readOnlyTimeoutMillis("codex.readHistoryPage", params));
        assertEquals(30_000L, CodexSDKBridge.readOnlyTimeoutMillis("codex.readThread", params));
    }

    @Test
    public void timedOutReadCancelsDaemonRegistrationAndReturnsTypedTimeout() {
        CompletableFuture<Boolean> pending = new CompletableFuture<>();
        DaemonBridge daemon = new DaemonBridge(null, null, null) {
            @Override
            public CompletableFuture<Boolean> sendCommand(String method, JsonObject params, DaemonOutputCallback callback) {
                return pending;
            }
        };
        CodexAppServerRequestExecutor executor = new CodexAppServerRequestExecutor(
                Logger.getInstance(CodexReadOnlyTimeoutTest.class), line -> { });
        JsonObject result = executor.sendReadOnlyCommand(daemon, "codex.readSubagent", new JsonObject(), 20);
        assertEquals("timeout", result.get("errorCode").getAsString());
        assertTrue(pending.isCancelled());
    }
}

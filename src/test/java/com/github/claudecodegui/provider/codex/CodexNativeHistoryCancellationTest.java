package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/** Exercises startup cancellation through the native history path without a real CLI or account. */
public class CodexNativeHistoryCancellationTest {

    @Rule
    public final TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void cancellationBeforeReadNeverDispatchesToTheNativeRuntime() throws Exception {
        FixtureBridge bridge = new FixtureBridge(folder.newFolder("cancelled").toPath());

        assertThrows(CancellationException.class,
                () -> bridge.getSessionMessages("fixture-thread", "fixture-workspace", "fixture-channel", () -> true));

        assertEquals(0, bridge.reads.get());
    }

    @Test
    public void cancellationEndsABlockedDisplayReadAndAnIndependentRetryStillUsesTheChatHost() throws Exception {
        FixtureBridge bridge = new FixtureBridge(folder.newFolder("blocked").toPath());
        AtomicBoolean cancelled = new AtomicBoolean();
        CompletableFuture<JsonObject> blockedResponse = bridge.response;
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<?> reading = executor.submit(() -> assertThrows(CancellationException.class,
                    () -> bridge.getSessionMessages("fixture-thread", "fixture-workspace", "fixture-channel", cancelled::get)));
            assertTrue(bridge.started.await(2, TimeUnit.SECONDS));
            cancelled.set(true);
            reading.get(2, TimeUnit.SECONDS);
            assertTrue(blockedResponse.isCancelled());

            bridge.response = CompletableFuture.completedFuture(JsonParser.parseString("""
                    {"thread":{"id":"fixture-thread"},"readMode":"paged","cursor":null,"messages":[
                      {"type":"user","raw":{"message":{"content":[{"type":"text","text":"native history"}]}}}]}
                    """).getAsJsonObject());
            var messages = bridge.getSessionMessages("fixture-thread", "fixture-workspace", "fixture-channel", () -> false);
            assertEquals(1, messages.size());
            assertEquals("native history", messages.get(0).get("content").getAsString());
            assertEquals("fixture-channel", bridge.channel);
            assertEquals(2, bridge.reads.get());
        } finally {
            cancelled.set(true);
            executor.shutdownNow();
            assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS));
        }
    }

    @Test
    public void nativeAuthenticationFailuresRemainErrorsInsteadOfSelectingLegacyHistory() throws Exception {
        FixtureBridge bridge = new FixtureBridge(folder.newFolder("unauthorized").toPath());
        bridge.response = CompletableFuture.completedFuture(
                JsonParser.parseString("{\"error\":\"Authentication failed\"}").getAsJsonObject());

        IllegalStateException error = assertThrows(IllegalStateException.class,
                () -> bridge.getSessionMessages("fixture-thread", "fixture-workspace", "fixture-channel", () -> false));

        assertEquals("Native Codex history failed", error.getMessage());
        assertTrue(error.getCause().getMessage().contains("Authentication failed"));
        assertEquals(1, bridge.reads.get());
    }

    private static final class FixtureBridge extends CodexSDKBridge {
        private final AtomicInteger reads = new AtomicInteger();
        private final CountDownLatch started = new CountDownLatch(1);
        private CompletableFuture<JsonObject> response = new CompletableFuture<>();
        private String channel;

        private FixtureBridge(Path sessions) {
            super(sessions, new CodemossSettingsService() {
                @Override
                public String getCodexRuntimeAccessMode() {
                    return CODEX_RUNTIME_ACCESS_CLI_LOGIN;
                }
            }, () -> {
                throw new AssertionError("Display-read fixtures must not start a real daemon");
            }, sessions.toString());
        }

        @Override
        public CompletableFuture<JsonObject> readCodexNative(
                String method, String channelId, String cwd, String threadId, JsonObject params) {
            assertEquals("codex.readHistoryPage", method);
            assertEquals("fixture-thread", threadId);
            assertEquals("fixture-workspace", cwd);
            this.channel = channelId;
            this.reads.incrementAndGet();
            this.started.countDown();
            return this.response;
        }
    }
}

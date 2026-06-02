package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SessionHandlerTest {

    @Test
    public void sendMessageIgnoresClientControlledForkSession() throws Exception {
        RecordingSession session = new RecordingSession();
        SessionHandler handler = createHandler(session);

        handler.handle("send_message", "{\"text\":\"hello\",\"forkSession\":true}");

        assertTrue(session.awaitSend());
        assertFalse(session.lastForkSession);
    }

    @Test
    public void sendMessageWithAttachmentsIgnoresClientControlledForkSession() throws Exception {
        RecordingSession session = new RecordingSession();
        SessionHandler handler = createHandler(session);

        handler.handle("send_message_with_attachments", "{\"text\":\"hello\",\"attachments\":[],\"forkSession\":true}");

        assertTrue(session.awaitSend());
        assertFalse(session.lastForkSession);
    }

    private static SessionHandler createHandler(RecordingSession session) {
        HandlerContext context = new HandlerContext(
                null,
                new ReadyClaudeSDKBridge(),
                new CodexSDKBridge(),
                new CodemossSettingsService(),
                new NoopJsCallback()
        );
        context.setSession(session);
        return new TestableSessionHandler(context);
    }

    private static class TestableSessionHandler extends SessionHandler {
        TestableSessionHandler(HandlerContext context) {
            super(context);
        }

        @Override
        protected String determineWorkingDirectory() {
            return System.getProperty("user.dir");
        }
    }

    private static class ReadyClaudeSDKBridge extends ClaudeSDKBridge {
        @Override
        public String getCachedNodeVersion() {
            return "v22.0.0";
        }
    }

    private static class NoopJsCallback implements HandlerContext.JsCallback {
        @Override
        public void callJavaScript(String functionName, String... args) {
        }

        @Override
        public String escapeJs(String str) {
            return str;
        }
    }

    private static class RecordingSession extends ClaudeSession {
        private final CountDownLatch sendLatch = new CountDownLatch(1);
        private volatile boolean lastForkSession = true;

        RecordingSession() {
            super(null, null, null);
        }

        @Override
        public CompletableFuture<Void> send(
                String input,
                String agentPrompt,
                List<String> fileTagPaths,
                String requestedPermissionMode,
                boolean forkSession
        ) {
            this.lastForkSession = forkSession;
            sendLatch.countDown();
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletableFuture<Void> send(
                String input,
                List<Attachment> attachments,
                String agentPrompt,
                List<String> fileTagPaths,
                String requestedPermissionMode,
                boolean forkSession
        ) {
            this.lastForkSession = forkSession;
            sendLatch.countDown();
            return CompletableFuture.completedFuture(null);
        }

        boolean awaitSend() throws InterruptedException {
            return sendLatch.await(5, TimeUnit.SECONDS);
        }
    }
}

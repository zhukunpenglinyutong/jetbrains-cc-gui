package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionState;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ClaudeSDKBridgeRefactorTest {

    @Test
    public void cliInvocationModeRoutesImageAttachmentsToCliBridge() throws Exception {
        TestClaudeSDKBridge bridge = new TestClaudeSDKBridge();
        bridge.setCliResult(successResult("cli"));
        bridge.setDaemonResult(successResult("daemon"));
        bridge.setProcessResult(successResult("process"));

        List<ClaudeSession.Attachment> attachments = new ArrayList<>();
        attachments.add(createAttachment("image.png", "image/png", "c21hbGwtaW1hZ2U="));

        SDKResult result = bridge.sendMessage(
                "channel-1",
                "describe image",
                "session-1",
                null,
                "/workspace",
                attachments,
                "default",
                "claude-sonnet-4-6",
                null,
                null,
                Boolean.TRUE,
                Boolean.FALSE,
                "medium",
                "cli",
                new NoopCallback()
        ).get();

        assertTrue(result.success);
        assertEquals(1, bridge.cliCalls.get());
        assertEquals(0, bridge.daemonCalls.get());
        assertEquals(0, bridge.processCalls.get());
    }

    @Test
    public void cliInvocationModeRoutesNonImageAttachmentsToCliBridge() throws Exception {
        TestClaudeSDKBridge bridge = new TestClaudeSDKBridge();
        bridge.setCliResult(successResult("cli"));
        bridge.setDaemonResult(successResult("daemon"));
        bridge.setProcessResult(successResult("process"));

        List<ClaudeSession.Attachment> attachments = new ArrayList<>();
        attachments.add(createAttachment("note.txt", "text/plain", "c21hbGwtaW1hZ2U="));

        SDKResult result = bridge.sendMessage(
                "channel-1",
                "describe file",
                "session-1",
                null,
                "/workspace",
                attachments,
                "default",
                "claude-sonnet-4-6",
                null,
                null,
                Boolean.TRUE,
                Boolean.FALSE,
                "medium",
                "cli",
                new NoopCallback()
        ).get();

        assertTrue(result.success);
        assertEquals(1, bridge.cliCalls.get());
        assertEquals(0, bridge.daemonCalls.get());
        assertEquals(0, bridge.processCalls.get());
    }

    @Test
    public void sdkInvocationModeDoesNotUseCliBridge() throws Exception {
        TestClaudeSDKBridge bridge = new TestClaudeSDKBridge();
        bridge.setCliResult(successResult("cli"));
        bridge.setDaemonResult(successResult("daemon"));
        bridge.setProcessResult(successResult("process"));

        SDKResult result = bridge.sendMessage(
                "channel-1",
                "normal sdk request",
                "session-1",
                null,
                "/workspace",
                null,
                "default",
                "claude-sonnet-4-6",
                null,
                null,
                Boolean.TRUE,
                Boolean.FALSE,
                "medium",
                "sdk",
                new NoopCallback()
        ).get();

        assertTrue(result.success);
        assertEquals(0, bridge.cliCalls.get());
        assertEquals(1, bridge.daemonCalls.get() + bridge.processCalls.get());
    }

    @Test
    public void interruptChannelPassesChannelIdToDaemonAbort() throws Exception {
        String source = java.nio.file.Files.readString(java.nio.file.Paths.get(
                "src", "main", "java", "com", "github", "claudecodegui", "provider", "claude", "ClaudeSDKBridge.java"
        ));

        assertTrue(source.contains("db.sendAbort(channelId)"));
        assertTrue(source.contains("super.interruptChannel(channelId)"));
    }

    @Test
    public void defaultClaudeInvocationModeIsSdk() {
        SessionState state = new SessionState();

        assertEquals("sdk", state.getClaudeInvocationMode());
    }

    private ClaudeSession.Attachment createAttachment(String fileName, String mediaType, String data) {
        return new ClaudeSession.Attachment(fileName, mediaType, data);
    }

    private SDKResult successResult(String marker) {
        SDKResult result = new SDKResult();
        result.success = true;
        result.finalResult = marker;
        return result;
    }

    private static class NoopCallback implements MessageCallback {
        @Override
        public void onMessage(String type, String content) {
        }

        @Override
        public void onError(String error) {
        }

        @Override
        public void onComplete(SDKResult result) {
        }
    }

    private static class TestClaudeSDKBridge extends ClaudeSDKBridge {
        private final AtomicInteger cliCalls = new AtomicInteger();
        private final AtomicInteger daemonCalls = new AtomicInteger();
        private final AtomicInteger processCalls = new AtomicInteger();
        private CompletableFuture<SDKResult> cliResult = CompletableFuture.completedFuture(new SDKResult());
        private CompletableFuture<SDKResult> daemonResult = CompletableFuture.completedFuture(new SDKResult());
        private CompletableFuture<SDKResult> processResult = CompletableFuture.completedFuture(new SDKResult());

        void setCliResult(SDKResult result) {
            cliResult = CompletableFuture.completedFuture(result);
        }

        void setDaemonResult(SDKResult result) {
            daemonResult = CompletableFuture.completedFuture(result);
        }

        void setProcessResult(SDKResult result) {
            processResult = CompletableFuture.completedFuture(result);
        }

        @Override
        public void refreshInvocationMode() {
        }

        @Override
        protected DaemonBridge getDaemonBridgeForSend() {
            return null;
        }

        @Override
        protected CompletableFuture<SDKResult> sendViaCliBridge(
                String channelId,
                String message,
                String sessionId,
                String runtimeSessionEpoch,
                String cwd,
                List<ClaudeSession.Attachment> attachments,
                String permissionMode,
                String model,
                JsonObject openedFiles,
                String agentPrompt,
                Boolean streaming,
                Boolean disableThinking,
                String reasoningEffort,
                MessageCallback callback
        ) {
            cliCalls.incrementAndGet();
            return cliResult;
        }

        @Override
        protected CompletableFuture<SDKResult> sendViaDaemonBridge(
                DaemonBridge daemon,
                String channelId,
                String message,
                String sessionId,
                String runtimeSessionEpoch,
                String cwd,
                List<ClaudeSession.Attachment> attachments,
                String permissionMode,
                String model,
                JsonObject openedFiles,
                String agentPrompt,
                Boolean streaming,
                Boolean disableThinking,
                String reasoningEffort,
                MessageCallback callback
        ) {
            daemonCalls.incrementAndGet();
            return daemonResult;
        }

        @Override
        protected CompletableFuture<SDKResult> sendViaProcessInvoker(
                String channelId,
                String message,
                String sessionId,
                String runtimeSessionEpoch,
                String cwd,
                List<ClaudeSession.Attachment> attachments,
                String permissionMode,
                String model,
                JsonObject openedFiles,
                String agentPrompt,
                Boolean streaming,
                Boolean disableThinking,
                String reasoningEffort,
                MessageCallback callback
        ) {
            processCalls.incrementAndGet();
            return processResult;
        }
    }
}

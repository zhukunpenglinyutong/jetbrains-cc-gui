package com.github.claudecodegui.session;

import org.junit.Test;

import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;

import java.util.List;

import static org.junit.Assert.assertEquals;

public class ClaudeSessionTest {

    @Test
    public void setSessionInfoNotifiesSessionIdWhenRestoringHistorySession() {
        ClaudeSession session = new ClaudeSession(null, null, null);
        RecordingCallback callback = new RecordingCallback();
        session.setCallback(callback);

        session.setSessionInfo("history-session-123", "/workspace/demo");

        assertEquals("history-session-123", session.getSessionId());
        assertEquals("history-session-123", callback.lastSessionId);
        assertEquals("/workspace/demo", session.getCwd());
    }

    @Test
    public void disposeClearsCallbackAndCodexThreadCache() {
        RecordingCodexSDKBridge codexBridge = new RecordingCodexSDKBridge();
        ClaudeSession session = new ClaudeSession(null, new ClaudeSDKBridge(), codexBridge);
        RecordingCallback callback = new RecordingCallback();
        session.setCallback(callback);
        session.setProvider("codex");
        session.setSessionInfo("thread-123", "/workspace/demo");

        session.dispose();

        assertEquals("thread-123", codexBridge.lastClearedThreadId);
        session.setSessionInfo("history-session-456", "/workspace/next");
        assertEquals("thread-123", callback.lastSessionId);
    }

    private static class RecordingCallback implements ClaudeSession.SessionCallback {
        private String lastSessionId;

        @Override
        public void onMessageUpdate(List<ClaudeSession.Message> messages) {
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
        }

        @Override
        public void onSessionIdReceived(String sessionId) {
            this.lastSessionId = sessionId;
        }

        @Override
        public void onPermissionRequested(com.github.claudecodegui.permission.PermissionRequest request) {
        }

        @Override
        public void onThinkingStatusChanged(boolean isThinking) {
        }

        @Override
        public void onSlashCommandsReceived(List<String> slashCommands) {
        }

        @Override
        public void onNodeLog(String log) {
        }

        @Override
        public void onSummaryReceived(String summary) {
        }
    }

    private static class RecordingCodexSDKBridge extends CodexSDKBridge {
        private String lastClearedThreadId;

        @Override
        public void clearCachedThread(String threadId, String cwd) {
            this.lastClearedThreadId = threadId;
        }
    }
}

package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class SessionProviderRouterTest {

    @Test
    public void cleanupProviderSessionClearsCodexThreadOnlyForCodex() {
        RecordingCodexSDKBridge codexBridge = new RecordingCodexSDKBridge();
        SessionProviderRouter router = new SessionProviderRouter(null, codexBridge);

        router.cleanupProviderSession("claude", "session-a", "/workspace/a");
        assertEquals(0, codexBridge.clearCalls);

        router.cleanupProviderSession("codex", "thread-b", "/workspace/b");
        assertEquals(1, codexBridge.clearCalls);
        assertEquals("thread-b", codexBridge.lastThreadId);
    }

    private static class RecordingCodexSDKBridge extends CodexSDKBridge {
        private int clearCalls;
        private String lastThreadId;

        @Override
        public void clearCachedThread(String threadId, String cwd) {
            clearCalls++;
            lastThreadId = threadId;
        }
    }
}

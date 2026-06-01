package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.SessionState;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeSDKBridgeRefactorTest {

    @Test
    public void interruptChannelPassesChannelIdToDaemonAbort() throws Exception {
        String source = java.nio.file.Files.readString(java.nio.file.Paths.get(
                "src", "main", "java", "com", "github", "claudecodegui", "provider", "claude", "ClaudeSDKBridge.java"
        ));

        assertTrue(source.contains("db.sendAbort(channelId)"));
        assertTrue(source.contains("super.interruptChannel(channelId)"));
    }

    @Test
    public void claudeSdkBridgeDoesNotReferenceCliBridge() throws Exception {
        String source = java.nio.file.Files.readString(java.nio.file.Paths.get(
                "src", "main", "java", "com", "github", "claudecodegui", "provider", "claude", "ClaudeSDKBridge.java"
        ));

        assertFalse(source.contains("ClaudeCliBridge"));
        assertFalse(source.contains("sendViaCliBridge"));
        assertFalse(source.contains("getCliBridge"));
    }

    @Test
    public void defaultClaudeInvocationModeIsSdk() {
        SessionState state = new SessionState();

        assertEquals("sdk", state.getClaudeInvocationMode());
    }
}

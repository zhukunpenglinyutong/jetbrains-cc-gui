package com.github.claudecodegui.provider.opencode;

import org.junit.Test;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class OpenCodeSDKBridgeTest {

    @Test
    public void daemonStoppedAfterStreamEndIsIgnorable() {
        RuntimeException error = new RuntimeException(new RuntimeException("Daemon stopped"));

        assertTrue(OpenCodeSDKBridge.isIgnorableDaemonStopAfterStreamEnd(error, true));
    }

    @Test
    public void daemonProcessDiedAfterStreamEndIsIgnorable() {
        RuntimeException error = new RuntimeException("Daemon process died unexpectedly");

        assertTrue(OpenCodeSDKBridge.isIgnorableDaemonStopAfterStreamEnd(error, true));
    }

    @Test
    public void daemonStoppedSendErrorAfterStreamEndIsIgnorable() {
        String line = "[SEND_ERROR] {\"error\":\"java.lang.RuntimeException: Daemon stopped\"}";

        assertTrue(OpenCodeSDKBridge.isIgnorableDaemonStopLineAfterStreamEnd(line, true));
    }

    @Test
    public void daemonStoppedSendErrorBeforeStreamEndIsNotIgnorable() {
        String line = "[SEND_ERROR] {\"error\":\"java.lang.RuntimeException: Daemon stopped\"}";

        assertFalse(OpenCodeSDKBridge.isIgnorableDaemonStopLineAfterStreamEnd(line, false));
    }

    @Test
    public void providerSendErrorAfterStreamEndRemainsVisible() {
        String line = "[SEND_ERROR] {\"error\":\"Input exceeds context window of this model\"}";

        assertFalse(OpenCodeSDKBridge.isIgnorableDaemonStopLineAfterStreamEnd(line, true));
    }

    @Test
    public void falseDaemonCompletionAfterStreamEndWithoutProviderErrorIsComplete() {
        assertTrue(OpenCodeSDKBridge.shouldTreatDaemonFailureAsCompleteAfterStreamEnd(true, null));
    }

    @Test
    public void falseDaemonCompletionAfterStreamEndWithDaemonErrorIsComplete() {
        assertTrue(OpenCodeSDKBridge.shouldTreatDaemonFailureAsCompleteAfterStreamEnd(true, "Daemon stopped"));
    }

    @Test
    public void falseDaemonCompletionAfterStreamEndWithProviderErrorRemainsFailed() {
        assertFalse(OpenCodeSDKBridge.shouldTreatDaemonFailureAsCompleteAfterStreamEnd(
                true,
                "Input exceeds context window of this model"));
    }

    @Test
    public void daemonStoppedBeforeStreamEndIsNotIgnorable() {
        RuntimeException error = new RuntimeException("Daemon stopped");

        assertFalse(OpenCodeSDKBridge.isIgnorableDaemonStopAfterStreamEnd(error, false));
    }

    @Test
    public void providerErrorsRemainVisibleAfterStreamEnd() {
        RuntimeException error = new RuntimeException("Input exceeds context window of this model");

        assertFalse(OpenCodeSDKBridge.isIgnorableDaemonStopAfterStreamEnd(error, true));
    }

    @Test
    public void recoveryPromptIncludesRecentMessagesFailedPromptAndFiles() {
        JsonObject userMessage = new JsonObject();
        userMessage.addProperty("type", "user");
        userMessage.addProperty("content", "Please update the quota popup docs");

        JsonObject toolInput = new JsonObject();
        toolInput.addProperty("file_path", "docs/quota-popup.png");
        JsonObject toolBlock = new JsonObject();
        toolBlock.addProperty("type", "tool_use");
        toolBlock.addProperty("name", "edit");
        toolBlock.add("input", toolInput);
        JsonArray content = new JsonArray();
        content.add(toolBlock);
        JsonObject assistantMessage = new JsonObject();
        assistantMessage.addProperty("type", "assistant");
        assistantMessage.add("content", content);

        String prompt = OpenCodeSDKBridge.buildRecoveryPrompt(
                List.of(userMessage, assistantMessage),
                "Retry the failed documentation update",
                "ses_test",
                "/tmp/project");

        assertTrue(prompt.contains("Continue this work in a fresh opencode session"));
        assertTrue(prompt.contains("Working directory: /tmp/project"));
        assertTrue(prompt.contains("Previous session: ses_test"));
        assertTrue(prompt.contains("docs/quota-popup.png"));
        assertTrue(prompt.contains("user: Please update the quota popup docs"));
        assertTrue(prompt.contains("Failed request to continue:"));
        assertTrue(prompt.contains("Retry the failed documentation update"));
    }
}

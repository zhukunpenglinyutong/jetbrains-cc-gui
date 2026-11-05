package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Verifies native Codex control commands fail truthfully before a thread exists. */
public class CodexSDKBridgeCommandTest {

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void compactWithoutThreadReturnsActionableError() throws Exception {
        CodexSDKBridge bridge = new CodexSDKBridge(temporaryFolder.newFolder("sessions").toPath());

        JsonObject result = bridge.compactCodex("channel", temporaryFolder.getRoot().getAbsolutePath(), "")
                .get();

        assertTrue(result.has("error"));
        assertTrue(result.get("error").getAsString().contains("Start a Codex conversation"));
    }

    @Test
    public void answeringAnUnknownInteractionIsMarkedNotRetryable() throws Exception {
        CodexSDKBridge bridge = new CodexSDKBridge(temporaryFolder.newFolder("sessions").toPath());
        JsonObject decision = new JsonObject();
        decision.addProperty("decision", "accept");

        JsonObject result = bridge.respondCodexInteraction(
                "channel", temporaryFolder.getRoot().getAbsolutePath(), "missing-key", "missing-token", decision);

        assertTrue(result.has("error"));
        assertTrue(result.has("retryable"));
        assertFalse(result.get("retryable").getAsBoolean());
    }

    @Test
    public void onlyAnAnswerCodexNoLongerAwaitsEndsTheRegisteredRequest() {
        JsonObject notPending = new JsonObject();
        notPending.addProperty("error", "Codex is no longer waiting for this answer");
        notPending.addProperty("code", "INTERACTION_NOT_PENDING");
        JsonObject correctable = new JsonObject();
        correctable.addProperty("error", "invalid native Codex interaction result");
        correctable.addProperty("code", "INVALID_INTERACTION_RESULT");
        JsonObject unconfirmed = new JsonObject();
        unconfirmed.addProperty("error", "codex.respondInteraction timed out after 10000 ms");
        unconfirmed.addProperty("deliveryUnconfirmed", true);

        assertTrue(CodexSDKBridge.endsInteraction(new JsonObject()));
        assertTrue(CodexSDKBridge.endsInteraction(notPending));
        assertFalse(CodexSDKBridge.endsInteraction(correctable));
        // A late delivery is still possible, so the request may yet be resolved by Codex.
        assertFalse(CodexSDKBridge.endsInteraction(unconfirmed));
    }
}

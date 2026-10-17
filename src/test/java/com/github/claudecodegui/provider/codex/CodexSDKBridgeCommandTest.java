package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

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
}

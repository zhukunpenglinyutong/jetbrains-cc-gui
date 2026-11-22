package com.github.claudecodegui.provider.codex;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/** Ordinary Codex loads keep their empty-transcript contract; only restore reads fail loudly. */
public class CodexLegacyHistoryContractTest {

    @Rule
    public final TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void unreadableRolloutIsEmptyForOrdinaryLoadsAndRetryableForRestore() throws Exception {
        Path sessions = folder.newFolder("sessions").toPath();
        // 0xC3 0x28 is not valid UTF-8, so the strict line reader fails mid-file.
        Files.write(sessions.resolve("broken-session.jsonl"), new byte[]{'{', (byte) 0xC3, (byte) 0x28, '}', '\n'});
        CodexSDKBridge bridge = new CodexSDKBridge(sessions);

        assertTrue(bridge.getSessionMessages("broken-session", "/workspace").isEmpty());
        assertTrue(bridge.getSessionMessages("broken-session", "/workspace", "channel").isEmpty());
        assertThrows(IllegalStateException.class,
                () -> bridge.getSessionMessages("broken-session", "/workspace", "channel", () -> false));
    }
}

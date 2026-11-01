package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.settings.CodemossSettingsService;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** Deletion leases keep new native writers away while rollout files are removed. */
public class CodexDeletionReservationTest {

    private static final String OTHER_WINDOW = "deletion-test-other-window";

    /** Isolates the owner scope from real Codex homes. */
    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void reservationBlocksEveryWriterUntilReleased() throws Exception {
        Path home = this.folder.newFolder("home").toPath();
        CodexSDKBridge bridge = new CodexSDKBridge(home, new CodemossSettingsService(), () -> null, home.toString());
        try {
            Runnable release = bridge.reserveCodexThreadsForDeletion(List.of("root-a", "root-b"));

            assertNotNull(release);
            assertTrue(bridge.hasCodexThreadOwner("root-a"));
            assertFalse("the reservation is not this window's writer", bridge.ownsCodexThread("root-a"));
            assertFalse(CodexThreadOwnerRegistry.claim(home.toString(), "root-b", OTHER_WINDOW).acquired());

            release.run();

            assertFalse(bridge.hasCodexThreadOwner("root-a"));
            assertTrue(CodexThreadOwnerRegistry.claim(home.toString(), "root-b", OTHER_WINDOW).acquired());
        } finally {
            CodexThreadOwnerRegistry.releaseOwner(OTHER_WINDOW);
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void anExistingWriterRefusesTheWholeReservation() throws Exception {
        Path home = this.folder.newFolder("busy-home").toPath();
        CodexSDKBridge bridge = new CodexSDKBridge(home, new CodemossSettingsService(), () -> null, home.toString());
        try {
            assertTrue(CodexThreadOwnerRegistry.claim(home.toString(), "root-b", OTHER_WINDOW).acquired());

            assertNull(bridge.reserveCodexThreadsForDeletion(List.of("root-a", "root-b")));

            assertFalse("a refused reservation leaves no partial lease", bridge.hasCodexThreadOwner("root-a"));
            assertTrue(bridge.hasCodexThreadOwner("root-b"));
        } finally {
            CodexThreadOwnerRegistry.releaseOwner(OTHER_WINDOW);
            bridge.cleanupAllProcesses();
        }
    }
}

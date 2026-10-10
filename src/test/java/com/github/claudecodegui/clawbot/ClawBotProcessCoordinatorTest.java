package com.github.claudecodegui.clawbot;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class ClawBotProcessCoordinatorTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void onlyOneCoordinatorCanOwnTheLeaderLock() throws Exception {
        Path runtime = temporaryFolder.getRoot().toPath().resolve("clawbot-runtime");
        ClawBotProcessCoordinator first = new ClawBotProcessCoordinator(runtime, "ide-a");
        ClawBotProcessCoordinator second = new ClawBotProcessCoordinator(runtime, "ide-b");

        try (ClawBotProcessCoordinator.LeaderLease ignored = first.tryAcquireLeader("local://ide-a")) {
            assertNotNull(ignored);
            assertNull(second.tryAcquireLeader("local://ide-b"));
            ClawBotProcessCoordinator.LeaderInfo owner = second.readLeader().orElse(null);
            assertNotNull(owner);
            assertEquals(1, owner.protocolVersion());
            assertEquals("ide-a", owner.instanceId());
            assertEquals("local://ide-a", owner.endpoint());
            assertTrue(owner.pid() > 0);
        }

        try (ClawBotProcessCoordinator.LeaderLease ignored = second.tryAcquireLeader("local://ide-b")) {
            assertNotNull(ignored);
            assertEquals("ide-b", second.readLeader().orElseThrow().instanceId());
        }
        assertTrue(second.readLeader().isEmpty());
    }

    @Test
    public void rejectsSymbolicLinkRuntimeDirectory() throws Exception {
        Path parent = temporaryFolder.getRoot().toPath();
        Path target = parent.resolve("target");
        Path runtime = parent.resolve("runtime");
        java.nio.file.Files.createDirectory(target);
        try {
            java.nio.file.Files.createSymbolicLink(runtime, target);
        } catch (UnsupportedOperationException error) {
            return;
        }

        try {
            new ClawBotProcessCoordinator(runtime, "ide-a").tryAcquireLeader("local://ide-a");
        } catch (java.io.IOException error) {
            assertEquals("CLAWBOT_RUNTIME_UNAVAILABLE", error.getMessage());
            return;
        }
        throw new AssertionError("symbolic-link runtime should be rejected");
    }
}

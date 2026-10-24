package com.github.claudecodegui.bridge;

import org.junit.Test;
import org.junit.Assume;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class DshHostProcessCoordinatorTest {

    @Test
    public void retainedOwnedHostBlocksMigrationUntilReleased() throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();
        DshHostProcessCoordinator coordinator = new DshHostProcessCoordinator(gate, () -> false);

        coordinator.retainOwnedHost(coordinator.acquireCommandPermit(), ProcessHandle.current().pid());
        try {
            assertTrue(coordinator.hasRunningHost());
            assertNull(gate.tryAcquireMigrationPermit());
        } finally {
            coordinator.releaseOwnedHost(ProcessHandle.current().pid());
        }

        try (AiDataProcessGate.MigrationPermit migrationPermit = gate.tryAcquireMigrationPermit()) {
            assertNotNull(migrationPermit);
        }
    }

    @Test
    public void keepsPermitsForOtherRunningHostsWhenOneStops() throws Exception {
        long currentPid = ProcessHandle.current().pid();
        ProcessHandle parent = ProcessHandle.current().parent().orElse(null);
        Assume.assumeTrue(parent != null && parent.isAlive());
        long parentPid = parent.pid();
        AiDataProcessGate gate = new AiDataProcessGate();
        DshHostProcessCoordinator coordinator = new DshHostProcessCoordinator(gate, () -> false);

        coordinator.retainOwnedHost(coordinator.acquireCommandPermit(), currentPid);
        coordinator.retainOwnedHost(coordinator.acquireCommandPermit(), parentPid);
        try {
            coordinator.releaseOwnedHost(parentPid + currentPid);
            assertNull(gate.tryAcquireMigrationPermit());
            coordinator.releaseOwnedHost(parentPid);
            assertTrue(coordinator.hasRunningHost());
            assertNull(gate.tryAcquireMigrationPermit());
        } finally {
            coordinator.releaseOwnedHost(parentPid);
            coordinator.releaseOwnedHost(currentPid);
        }

        try (AiDataProcessGate.MigrationPermit migrationPermit = gate.tryAcquireMigrationPermit()) {
            assertNotNull(migrationPermit);
        }
    }

    @Test
    public void externalHostDetectorFailsClosedWithoutTakingOwnership() {
        AiDataProcessGate gate = new AiDataProcessGate();
        DshHostProcessCoordinator coordinator = new DshHostProcessCoordinator(gate, () -> true);

        assertTrue(coordinator.hasRunningHost());
        try (AiDataProcessGate.MigrationPermit migrationPermit = gate.tryAcquireMigrationPermit()) {
            assertNotNull(migrationPermit);
        }
    }

    @Test
    public void noTrackedOrExternalHostReportsIdle() {
        DshHostProcessCoordinator coordinator = new DshHostProcessCoordinator(
                new AiDataProcessGate(), () -> false);

        assertFalse(coordinator.hasRunningHost());
    }

    @Test
    public void recognizesQuotedWindowsAndUnixDshWebCommands() {
        assertTrue(DshHostProcessCoordinator.looksLikeDshWebCommand(
                "\"C:\\Users\\dev\\AppData\\Roaming\\npm\\dsh.cmd\" web --port 3080"));
        assertTrue(DshHostProcessCoordinator.looksLikeDshWebCommand(
                "\"C:\\WINDOWS\\system32\\cmd.exe\" /d /s /c \"\"dsh.cmd\" \"web\" \"--port\" \"3080\"\""));
        assertTrue(DshHostProcessCoordinator.looksLikeDshWebCommand(
                "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\npm\\dsh.js\" \"web\" \"--port\" \"3080\""));
        assertTrue(DshHostProcessCoordinator.looksLikeDshWebCommand(
                "/usr/local/bin/dsh web --host 127.0.0.1"));
        assertFalse(DshHostProcessCoordinator.looksLikeDshWebCommand(
                "\"C:\\tools\\dsh.cmd\" \"websocket\" --port 3080"));
        assertFalse(DshHostProcessCoordinator.looksLikeDshWebCommand(
                "node channel-manager.js dsh status"));
        assertFalse(DshHostProcessCoordinator.looksLikeDshWebCommand(
                "C:\\tools\\not-dsh.exe web"));
    }
}

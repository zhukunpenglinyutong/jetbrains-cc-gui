package com.github.claudecodegui.provider.common;

import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Paths;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class DaemonBridgeTest {

    // HEARTBEAT_TIMEOUT_MS = 45_000; just over threshold triggers unresponsive
    private static final long JUST_OVER_HEARTBEAT_THRESHOLD = 46_000;
    // ACTIVE_REQUEST_HEARTBEAT_TIMEOUT_MS = 180_000; well over for active-request timeout
    private static final long OVER_ACTIVE_REQUEST_THRESHOLD = 190_000;
    // Recent activity within threshold
    private static final long RECENT_ACTIVITY = 5_000;

    @Test
    public void staleHeartbeatWithoutActiveRequestsIsUnresponsive() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(JUST_OVER_HEARTBEAT_THRESHOLD, JUST_OVER_HEARTBEAT_THRESHOLD, 0));
    }

    @Test
    public void activeRequestWithRecentOutputGetsGraceWindow() {
        assertFalse(DaemonBridge.shouldTreatAsUnresponsive(JUST_OVER_HEARTBEAT_THRESHOLD, RECENT_ACTIVITY, 1));
    }

    @Test
    public void activeRequestWithNoRecentOutputEventuallyTimesOut() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(OVER_ACTIVE_REQUEST_THRESHOLD, OVER_ACTIVE_REQUEST_THRESHOLD, 1));
    }

    @Test
    public void daemonBridgeUsesPlatformTerminationHelperForShutdownPaths() throws Exception {
        String source = Files.readString(Paths.get(
                "src", "main", "java", "com", "github", "claudecodegui", "provider", "common", "DaemonBridge.java"
        ));

        assertTrue(source.contains("PlatformUtils.terminateProcessAndWait(daemonProcess, 3, TimeUnit.SECONDS)"));
        assertTrue(source.contains("PlatformUtils.terminateProcessAndWait(oldProcess, 2, TimeUnit.SECONDS)"));
        assertFalse(source.contains("daemonProcess.destroyForcibly()"));
        assertFalse(source.contains("oldProcess.destroyForcibly()"));
    }
}

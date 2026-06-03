package com.github.claudecodegui.provider.opencode;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class OpenCodeSDKBridgeTest {

    @Test
    public void daemonStoppedAfterStreamEndIsIgnorable() {
        RuntimeException error = new RuntimeException(new RuntimeException("Daemon stopped"));

        assertTrue(OpenCodeSDKBridge.isIgnorableDaemonStopAfterStreamEnd(error, true));
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
}

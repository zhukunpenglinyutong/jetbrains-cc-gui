package com.github.claudecodegui.handler;

import com.github.claudecodegui.dependency.InstallResult;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit-tests {@link DependencyHandler#shouldRestartClaudeDaemon(InstallResult)}: the running
 * Claude daemon keeps the SDK it imported, so it must be restarted after the Claude SDK
 * changes, and only then.
 */
public class DependencyHandlerTest {

    @Test
    public void restartsClaudeDaemonAfterClaudeSdkInstall() {
        assertTrue(DependencyHandler.shouldRestartClaudeDaemon(
                InstallResult.success("claude-sdk", "0.3.300", "")));
    }

    @Test
    public void keepsClaudeDaemonWhenClaudeSdkInstallFails() {
        assertFalse(DependencyHandler.shouldRestartClaudeDaemon(
                InstallResult.failure("claude-sdk", "npm install failed with exit code: 1", "")));
    }

    @Test
    public void keepsClaudeDaemonWhenAnotherSdkChanges() {
        assertFalse(DependencyHandler.shouldRestartClaudeDaemon(
                InstallResult.success("codex-sdk", "0.155.0", "")));
    }
}

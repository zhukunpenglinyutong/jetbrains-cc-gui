package com.github.claudecodegui.session;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class SessionSendServiceTest {

    @Test
    public void normalizeRequestedPermissionModeRejectsBlankAndUnknownValues() {
        assertNull(SessionSendService.normalizeRequestedPermissionMode(null));
        assertNull(SessionSendService.normalizeRequestedPermissionMode(" "));
        assertNull(SessionSendService.normalizeRequestedPermissionMode("dangerouslyAllowEverything"));
    }

    @Test
    public void resolveEffectivePermissionModeKeepsSessionModeWhenRequestedDiffers() {
        assertEquals("default", SessionSendService.resolveEffectivePermissionMode("claude", "bypassPermissions", "default"));
        assertEquals(
                "acceptEdits", SessionSendService.resolveEffectivePermissionMode("codex", "bypassPermissions", "acceptEdits")
        );
    }

    @Test
    public void resolveEffectivePermissionModeDowngradesCodexPlanAfterSessionResolution() {
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("codex", null, "plan")
        );
    }

    @Test
    public void resolveEffectivePermissionModeFallsBackToRequestedModeWhenSessionModeMissing() {
        assertEquals("acceptEdits", SessionSendService.resolveEffectivePermissionMode("claude", "acceptEdits", null));
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("claude", null, null)
        );
    }

    @Test
    public void getCodexRuntimeAccessErrorRequiresAuthorizationOrManagedProvider() {
        assertEquals(
                "Codex local configuration access is not authorized. Please authorize local ~/.codex access or enable a managed Codex provider first.",
                SessionSendService.getCodexRuntimeAccessError("inactive")
        );
        assertNull(SessionSendService.getCodexRuntimeAccessError("managed"));
        assertNull(SessionSendService.getCodexRuntimeAccessError("cli_login"));
    }

    @Test
    public void resolveEffectiveClaudeInvocationModeKeepsRequestedCliMode() {
        assertEquals(
                "cli",
                SessionSendService.resolveEffectiveClaudeInvocationMode("cli")
        );
    }

    @Test
    public void resolveEffectiveClaudeInvocationModeKeepsRequestedSdkMode() {
        assertEquals(
                "sdk", SessionSendService.resolveEffectiveClaudeInvocationMode("sdk", "sdk"));
    }

    @Test
    public void resolveEffectiveClaudeInvocationModeKeepsConfiguredCliWhenFrontendSendsDefaultSdk() {
        assertEquals("cli", SessionSendService.resolveEffectiveClaudeInvocationMode("sdk", "cli"));
    }

    @Test
    public void resolveEffectiveClaudeInvocationModeIgnoresRequestedModeWhenSessionModeExists() {
        assertEquals("cli", SessionSendService.resolveEffectiveClaudeInvocationMode("sdk", "cli"));
        assertEquals("sdk", SessionSendService.resolveEffectiveClaudeInvocationMode("cli", "sdk")
        );
    }
}

package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.settings.CodemossSettingsService;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Verifies that inactive Codex access never permits a native child launch. */
public class CodexSDKBridgeAccessGateTest {

    @Test
    public void inactiveAccessDoesNotStartNativeRuntime() {
        assertFalse(CodexSDKBridge.isCodexRuntimeAccessAllowed(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE));
        assertFalse(CodexSDKBridge.isCodexRuntimeAccessAllowed(null));
        assertFalse(CodexSDKBridge.isCodexRuntimeAccessAllowed("unknown"));
        assertTrue(CodexSDKBridge.isCodexRuntimeAccessAllowed(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_MANAGED));
        assertTrue(CodexSDKBridge.isCodexRuntimeAccessAllowed(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN));
    }
}

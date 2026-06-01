package com.github.claudecodegui.cli.claude;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Pins the safety contract of {@link ClaudeCliPermissionMode#apply(List, String)}.
 */
public class ClaudeCliPermissionModeTest {

    @Test
    public void bypassPermissionsIsOnlyValueThatSkipsAllChecks() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliPermissionMode.apply(cmd, "bypassPermissions");
        assertEquals(List.of("--dangerously-skip-permissions"), cmd);
    }

    @Test
    public void defaultModeIsForwardedAsPermissionModeFlag() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliPermissionMode.apply(cmd, "default");
        assertEquals(List.of("--permission-mode", "default"), cmd);
    }

    @Test
    public void acceptEditsModeIsForwardedAsPermissionModeFlag() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliPermissionMode.apply(cmd, "acceptEdits");
        assertEquals(List.of("--permission-mode", "acceptEdits"), cmd);
    }

    @Test
    public void planModeIsForwardedAsPermissionModeFlag() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliPermissionMode.apply(cmd, "plan");
        assertEquals(List.of("--permission-mode", "plan"), cmd);
    }

    @Test
    public void nullPermissionModeFallsBackToAcceptEditsNotBypass() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliPermissionMode.apply(cmd, null);
        assertFalse("null must NEVER fall back to full bypass",
                cmd.contains("--dangerously-skip-permissions"));
        assertEquals(List.of("--permission-mode", "acceptEdits"), cmd);
    }

    @Test
    public void blankPermissionModeFallsBackToAcceptEditsNotBypass() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliPermissionMode.apply(cmd, "   ");
        assertFalse(cmd.contains("--dangerously-skip-permissions"));
        assertEquals(List.of("--permission-mode", "acceptEdits"), cmd);
    }

    @Test
    public void unknownPermissionModeFallsBackToAcceptEditsNotEchoedRaw() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliPermissionMode.apply(cmd, "letMeDoWhateverIWant");
        assertFalse("unknown value must NOT be echoed raw to the CLI",
                cmd.contains("letMeDoWhateverIWant"));
        assertFalse(cmd.contains("--dangerously-skip-permissions"));
        assertEquals(List.of("--permission-mode", "acceptEdits"), cmd);
    }

    @Test
    public void caseSensitiveBypassDoesNotMatchVariants() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliPermissionMode.apply(cmd, "BypassPermissions");
        assertFalse(cmd.contains("--dangerously-skip-permissions"));
        assertTrue(cmd.contains("--permission-mode"));
    }
}

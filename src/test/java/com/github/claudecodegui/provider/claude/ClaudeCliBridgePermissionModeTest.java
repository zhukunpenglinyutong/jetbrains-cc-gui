package com.github.claudecodegui.provider.claude;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Pins the safety contract of {@link ClaudeCliBridge#applyPermissionMode(List, String)}.
 *
 * <p>Regression guard for PR #1191 review item C1: prior to the fix, the CLI bridge
 * unconditionally added {@code --dangerously-skip-permissions} to every spawned
 * Claude CLI process, silently bypassing every permission gate. The new contract
 * is:
 *
 * <ul>
 *   <li>{@code "bypassPermissions"} is the ONLY value that yields
 *       {@code --dangerously-skip-permissions}.</li>
 *   <li>Any other recognized value ({@code default}, {@code acceptEdits},
 *       {@code plan}) is forwarded as {@code --permission-mode &lt;value&gt;}.</li>
 *   <li>{@code null}, blank, or unknown values fall back to a safe default
 *       ({@code acceptEdits}) — never to full bypass.</li>
 * </ul>
 */
public class ClaudeCliBridgePermissionModeTest {

    @Test
    public void bypassPermissionsIsOnlyValueThatSkipsAllChecks() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliBridge.applyPermissionMode(cmd, "bypassPermissions");
        assertEquals(List.of("--dangerously-skip-permissions"), cmd);
    }

    @Test
    public void defaultModeIsForwardedAsPermissionModeFlag() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliBridge.applyPermissionMode(cmd, "default");
        assertEquals(List.of("--permission-mode", "default"), cmd);
    }

    @Test
    public void acceptEditsModeIsForwardedAsPermissionModeFlag() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliBridge.applyPermissionMode(cmd, "acceptEdits");
        assertEquals(List.of("--permission-mode", "acceptEdits"), cmd);
    }

    @Test
    public void planModeIsForwardedAsPermissionModeFlag() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliBridge.applyPermissionMode(cmd, "plan");
        assertEquals(List.of("--permission-mode", "plan"), cmd);
    }

    @Test
    public void nullPermissionModeFallsBackToAcceptEditsNotBypass() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliBridge.applyPermissionMode(cmd, null);
        assertFalse("null must NEVER fall back to full bypass",
                cmd.contains("--dangerously-skip-permissions"));
        assertEquals(List.of("--permission-mode", "acceptEdits"), cmd);
    }

    @Test
    public void blankPermissionModeFallsBackToAcceptEditsNotBypass() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliBridge.applyPermissionMode(cmd, "   ");
        assertFalse(cmd.contains("--dangerously-skip-permissions"));
        assertEquals(List.of("--permission-mode", "acceptEdits"), cmd);
    }

    @Test
    public void unknownPermissionModeFallsBackToAcceptEditsNotEchoedRaw() {
        List<String> cmd = new ArrayList<>();
        ClaudeCliBridge.applyPermissionMode(cmd, "letMeDoWhateverIWant");
        assertFalse("unknown value must NOT be echoed raw to the CLI",
                cmd.contains("letMeDoWhateverIWant"));
        assertFalse(cmd.contains("--dangerously-skip-permissions"));
        assertEquals(List.of("--permission-mode", "acceptEdits"), cmd);
    }

    @Test
    public void caseSensitiveBypassDoesNotMatchVariants() {
        // Only exact "bypassPermissions" triggers the dangerous flag — defends against
        // accidental case drift like "BypassPermissions" silently bypassing.
        List<String> cmd = new ArrayList<>();
        ClaudeCliBridge.applyPermissionMode(cmd, "BypassPermissions");
        assertFalse(cmd.contains("--dangerously-skip-permissions"));
        assertTrue(cmd.contains("--permission-mode"));
    }
}

package com.github.claudecodegui.session.runtime;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CodexCliAdapterTest {

    @Test
    public void mapsBypassPermissionsToNoApprovalAndDangerSandbox() {
        CodexCliAdapter.PermissionSelection selected =
                CodexCliAdapter.selectPermission("bypassPermissions", "workspace-write");

        assertEquals("never", selected.approval());
        assertEquals("danger-full-access", selected.sandbox());
    }

    @Test
    public void mapsAutoEditToOnRequestAndKeepsConfiguredSandbox() {
        CodexCliAdapter.PermissionSelection selected =
                CodexCliAdapter.selectPermission("autoEdit", "workspace-write");

        assertEquals("on-request", selected.approval());
        assertEquals("workspace-write", selected.sandbox());
    }

    @Test
    public void placesCodexApprovalOptionBeforeExecSubcommand() {
        List<String> command = new ArrayList<>();
        CodexCliAdapter.addCodexExecutable(command, "codex");
        CodexCliAdapter.addCodexGlobalOptions(
                command,
                new CodexCliAdapter.PermissionSelection("on-request", "workspace-write")
        );
        command.add("exec");

        int approvalIndex = command.indexOf("--ask-for-approval");
        int execIndex = command.indexOf("exec");
        assertTrue(approvalIndex >= 0);
        assertTrue(execIndex >= 0);
        assertTrue(approvalIndex < execIndex);
        assertEquals("on-request", command.get(approvalIndex + 1));
    }

    @Test
    public void sanitizesProtectedEnvironmentKeys() {
        Map<String, String> env = CodexCliAdapter.sanitizeEnv(Map.of(
                "CODEX_MODEL", "blocked",
                "CUSTOM_KEY", "allowed",
                "PATH", "blocked"
        ));

        assertEquals("allowed", env.get("CUSTOM_KEY"));
        assertFalse(env.containsKey("CODEX_MODEL"));
        assertFalse(env.containsKey("PATH"));
    }
}

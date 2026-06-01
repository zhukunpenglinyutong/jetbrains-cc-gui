package com.github.claudecodegui.cli.codex;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;

public class CodexCliCommandUtilsTest {

    @Test
    public void defaultModeUsesSuggestApprovalWithConfiguredSandbox() {
        CodexCliCommandUtils.PermissionSelection selection =
                CodexCliCommandUtils.selectPermission("default", "workspace-write");

        assertEquals("untrusted", selection.approval());
        assertEquals("workspace-write", selection.sandbox());
    }

    @Test
    public void planModeUsesSuggestApprovalWithReadOnlySandbox() {
        CodexCliCommandUtils.PermissionSelection selection =
                CodexCliCommandUtils.selectPermission("plan", "danger-full-access");

        assertEquals("untrusted", selection.approval());
        assertEquals("read-only", selection.sandbox());
    }

    @Test
    public void acceptEditsModeUsesOnRequestWithConfiguredSandbox() {
        CodexCliCommandUtils.PermissionSelection selection =
                CodexCliCommandUtils.selectPermission("acceptEdits", "workspace-write");

        assertEquals("on-request", selection.approval());
        assertEquals("workspace-write", selection.sandbox());
    }

    @Test
    public void bypassPermissionsModeUsesNeverWithFullAccessSandbox() {
        CodexCliCommandUtils.PermissionSelection selection =
                CodexCliCommandUtils.selectPermission("bypassPermissions", "workspace-write");

        assertEquals("never", selection.approval());
        assertEquals("danger-full-access", selection.sandbox());
    }

    @Test
    public void unknownModeFallsBackToSuggestApproval() {
        CodexCliCommandUtils.PermissionSelection selection =
                CodexCliCommandUtils.selectPermission("unknown", "workspace-write");

        assertEquals("untrusted", selection.approval());
        assertEquals("workspace-write", selection.sandbox());
    }

    @Test
    public void globalOptionsReflectSelectedApprovalPolicy() {
        List<String> command = new ArrayList<>();
        CodexCliCommandUtils.addCodexGlobalOptions(
                command,
                new CodexCliCommandUtils.PermissionSelection("on-request", "workspace-write")
        );

        assertEquals(List.of("--ask-for-approval", "on-request"), command);
    }
}

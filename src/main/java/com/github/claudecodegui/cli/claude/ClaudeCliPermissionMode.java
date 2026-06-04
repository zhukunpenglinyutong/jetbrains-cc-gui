package com.github.claudecodegui.cli.claude;

import java.util.List;

/**
 * Applies the user-selected permission mode to Claude CLI commands.
 */
final class ClaudeCliPermissionMode {

    private ClaudeCliPermissionMode() {
    }

    static void apply(List<String> command, String permissionMode) {
        if ("bypassPermissions".equals(permissionMode)) {
            command.add("--dangerously-skip-permissions");
            return;
        }

        String mode = permissionMode;
        if (mode == null || mode.isBlank()) {
            mode = "acceptEdits";
        } else if (!"default".equals(mode) && !"acceptEdits".equals(mode) && !"plan".equals(mode)) {
            mode = "acceptEdits";
        }

        command.add("--permission-mode");
        command.add(mode);
    }
}

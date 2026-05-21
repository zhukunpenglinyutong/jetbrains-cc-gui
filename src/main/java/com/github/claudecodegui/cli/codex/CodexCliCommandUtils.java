package com.github.claudecodegui.cli.codex;

import com.github.claudecodegui.util.PlatformUtils;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Codex CLI 命令构建相关工具方法（独立于 SDK 和旧 adapter）。
 */
public final class CodexCliCommandUtils {

    private static final Set<String> PROTECTED_ENV_KEYS = Set.of(
            "CODEX_USE_STDIN", "CODEX_MODEL", "CODEX_SANDBOX_MODE", "CODEX_SANDBOX",
            "CODEX_APPROVAL_POLICY", "CODEX_CI", "CODEX_SANDBOX_NETWORK_DISABLED",
            "CODEX_HOME", "CLAUDE_SESSION_ID", "CLAUDE_PERMISSION_DIR",
            "HOME", "PATH", "TMPDIR", "TEMP", "TMP",
            "IDEA_PROJECT_PATH", "PROJECT_PATH", "CLAUDE_USE_STDIN"
    );

    private CodexCliCommandUtils() {}

    static PermissionSelection selectPermission(String permissionMode, String configuredSandbox) {
        String sandbox = normalizeSandbox(configuredSandbox);
        String approval;
        if ("bypassPermissions".equals(permissionMode)) {
            approval = "never";
            sandbox = "danger-full-access";
        } else if ("acceptEdits".equals(permissionMode) || "autoEdit".equals(permissionMode)) {
            approval = "on-request";
        } else {
            approval = "untrusted";
        }
        return new PermissionSelection(approval, sandbox);
    }

    static String normalizeSandbox(String sandbox) {
        if ("read-only".equals(sandbox) || "workspace-write".equals(sandbox) || "danger-full-access".equals(sandbox)) {
            return sandbox;
        }
        return PlatformUtils.isWindows() ? "danger-full-access" : "workspace-write";
    }

    public static void addCodexExecutable(List<String> command, String executable) {
        String resolved = executable != null && !executable.isBlank() ? executable : "codex";
        String lower = resolved.toLowerCase(Locale.ROOT);
        if (PlatformUtils.isWindows() && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
            command.add("cmd");
            command.add("/c");
            command.add(resolved);
            return;
        }
        command.add(resolved);
    }

    static void addCodexGlobalOptions(List<String> command, PermissionSelection permission) {
        command.add("--ask-for-approval");
        command.add(permission.approval());
    }

    static Map<String, String> sanitizeEnv(Map<String, String> env) {
        Map<String, String> result = new LinkedHashMap<>();
        if (env == null) return result;
        for (Map.Entry<String, String> entry : env.entrySet()) {
            String key = entry.getKey();
            if (key == null || key.trim().isEmpty()) continue;
            if (PROTECTED_ENV_KEYS.contains(key.toUpperCase(Locale.ROOT))) continue;
            result.put(key, entry.getValue());
        }
        return result;
    }

    record PermissionSelection(String approval, String sandbox) {}
}

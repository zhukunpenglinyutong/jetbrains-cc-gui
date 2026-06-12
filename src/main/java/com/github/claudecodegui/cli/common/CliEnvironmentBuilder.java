package com.github.claudecodegui.cli.common;

import com.github.claudecodegui.common.CommonConstants;
import com.github.claudecodegui.util.PlatformUtils;

import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Builds an isolated environment for CLI runtimes so they do not inherit
 * SDK-only or host sandbox variables from the parent IDE process.
 */
public final class CliEnvironmentBuilder {

    private CliEnvironmentBuilder() {
    }

    public static Map<String, String> buildBaseEnvironment() {
        Map<String, String> env = new LinkedHashMap<>();
        for (String key : CliConstants.WINDOWS_SYSTEM_ENV_KEYS) {
            copyIfPresent(env, key);
        }
        copyPath(env);
        copyHome(env);
        copyProxy(env);
        copyTerminalHints(env);
        ensureCodexHome(env);
        return env;
    }

    public static void configureProjectPath(Map<String, String> env, String cwd) {
        if (env == null || cwd == null || cwd.isBlank() || CommonConstants.UNDEFINED.equals(cwd) || CommonConstants.NULL_SENTINEL.equals(cwd)) {
            return;
        }
        env.put(CliConstants.ENV_IDEA_PROJECT_PATH, cwd);
        env.put(CliConstants.ENV_PROJECT_PATH, cwd);
    }

    public static void configureClaudePermissionEnv(
            Map<String, String> env,
            String permissionDir,
            String sessionId,
            long safetyNetMs
    ) {
        if (env == null) {
            return;
        }
        if (permissionDir != null && !permissionDir.isBlank()) {
            env.put(CliConstants.ENV_CLAUDE_PERMISSION_DIR, permissionDir);
        }
        if (sessionId != null && !sessionId.isBlank()) {
            env.put(CliConstants.ENV_CLAUDE_SESSION_ID, sessionId);
        }
        env.put(CliConstants.ENV_CLAUDE_PERMISSION_SAFETY_NET_MS, String.valueOf(safetyNetMs));
    }

    private static void copyPath(Map<String, String> env) {
        String path = PlatformUtils.isWindows()
                ? PlatformUtils.getEnvIgnoreCase("PATH")
                : System.getenv("PATH");
        if (path == null || path.isBlank()) {
            return;
        }
        env.put("PATH", path);
        if (PlatformUtils.isWindows()) {
            env.put("Path", path);
        }
    }

    private static void copyHome(Map<String, String> env) {
        String home = PlatformUtils.getHomeDirectory();
        if (home != null && !home.isBlank()) {
            env.put("HOME", home);
            if (PlatformUtils.isWindows()) {
                env.put("USERPROFILE", home);
            }
        }
        copyIfPresent(env, CommonConstants.ENV_HOMEDRIVE);
        copyIfPresent(env, CommonConstants.ENV_HOMEPATH);
    }

    private static void copyProxy(Map<String, String> env) {
        for (String key : CliConstants.PROXY_ENV_KEYS) {
            copyIfPresent(env, key);
            copyIfPresent(env, key.toLowerCase(Locale.ROOT));
        }
    }

    private static void copyTerminalHints(Map<String, String> env) {
        for (String key : CliConstants.TERMINAL_HINT_ENV_KEYS) {
            copyIfPresent(env, key);
        }
    }

    private static void ensureCodexHome(Map<String, String> env) {
        if (env.containsKey(CliConstants.ENV_CODEX_HOME) && !env.get(CliConstants.ENV_CODEX_HOME).isBlank()) {
            return;
        }
        String home = env.get("HOME");
        if (home == null || home.isBlank()) {
            home = PlatformUtils.getHomeDirectory();
        }
        if (home != null && !home.isBlank()) {
            env.put(CliConstants.ENV_CODEX_HOME, Paths.get(home, CommonConstants.DIR_CODEX).toString());
        }
    }

    private static void copyIfPresent(Map<String, String> env, String key) {
        String value = PlatformUtils.isWindows() ? PlatformUtils.getEnvIgnoreCase(key) : System.getenv(key);
        if (value != null && !value.isBlank()) {
            env.put(key, value);
        }
    }
}

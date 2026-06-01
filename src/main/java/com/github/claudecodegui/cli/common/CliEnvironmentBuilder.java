package com.github.claudecodegui.cli.common;

import com.github.claudecodegui.util.PlatformUtils;

import java.io.File;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Builds an isolated environment for CLI runtimes so they do not inherit
 * SDK-only or host sandbox variables from the parent IDE process.
 */
public final class CliEnvironmentBuilder {

    private static final String ENV_CODEX_HOME = "CODEX_HOME";
    private static final String ENV_CLAUDE_PERMISSION_DIR = "CLAUDE_PERMISSION_DIR";
    private static final String ENV_CLAUDE_SESSION_ID = "CLAUDE_SESSION_ID";
    private static final String ENV_CLAUDE_PERMISSION_SAFETY_NET_MS = "CLAUDE_PERMISSION_SAFETY_NET_MS";

    private CliEnvironmentBuilder() {
    }

    public static Map<String, String> buildBaseEnvironment() {
        Map<String, String> env = new LinkedHashMap<>();
        copyIfPresent(env, "SystemRoot");
        copyIfPresent(env, "ComSpec");
        copyIfPresent(env, "PATHEXT");
        copyIfPresent(env, "WINDIR");
        copyIfPresent(env, "NUMBER_OF_PROCESSORS");
        copyPath(env);
        copyHome(env);
        copyProxy(env);
        copyTerminalHints(env);
        ensureCodexHome(env);
        return env;
    }

    public static void configureProjectPath(Map<String, String> env, String cwd) {
        if (env == null || cwd == null || cwd.isBlank() || "undefined".equals(cwd) || "null".equals(cwd)) {
            return;
        }
        env.put("IDEA_PROJECT_PATH", cwd);
        env.put("PROJECT_PATH", cwd);
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
            env.put(ENV_CLAUDE_PERMISSION_DIR, permissionDir);
        }
        if (sessionId != null && !sessionId.isBlank()) {
            env.put(ENV_CLAUDE_SESSION_ID, sessionId);
        }
        env.put(ENV_CLAUDE_PERMISSION_SAFETY_NET_MS, String.valueOf(safetyNetMs));
    }

    private static void copyPath(Map<String, String> env) {
        String path = PlatformUtils.isWindows()
                ? PlatformUtils.getEnvIgnoreCase("PATH")
                : System.getenv("PATH");
        if (path == null || path.isBlank()) {
            return;
        }
        if (PlatformUtils.isWindows()) {
            env.put("PATH", path);
            env.put("Path", path);
        } else {
            env.put("PATH", path);
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
        copyIfPresent(env, "HOMEDRIVE");
        copyIfPresent(env, "HOMEPATH");
    }

    private static void copyProxy(Map<String, String> env) {
        for (String key : new String[]{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}) {
            copyIfPresent(env, key);
            copyIfPresent(env, key.toLowerCase(Locale.ROOT));
        }
    }

    private static void copyTerminalHints(Map<String, String> env) {
        copyIfPresent(env, "TERM");
        copyIfPresent(env, "TERM_PROGRAM");
        copyIfPresent(env, "COLORTERM");
        copyIfPresent(env, "LANG");
        copyIfPresent(env, "LC_ALL");
        copyIfPresent(env, "TMPDIR");
        copyIfPresent(env, "TEMP");
        copyIfPresent(env, "TMP");
    }

    private static void ensureCodexHome(Map<String, String> env) {
        if (env.containsKey(ENV_CODEX_HOME) && !env.get(ENV_CODEX_HOME).isBlank()) {
            return;
        }
        String home = env.get("HOME");
        if (home == null || home.isBlank()) {
            home = PlatformUtils.getHomeDirectory();
        }
        if (home != null && !home.isBlank()) {
            env.put(ENV_CODEX_HOME, Paths.get(home, ".codex").toString());
        }
    }

    private static void copyIfPresent(Map<String, String> env, String key) {
        String value = PlatformUtils.isWindows() ? PlatformUtils.getEnvIgnoreCase(key) : System.getenv(key);
        if (value != null && !value.isBlank()) {
            env.put(key, value);
        }
    }
}

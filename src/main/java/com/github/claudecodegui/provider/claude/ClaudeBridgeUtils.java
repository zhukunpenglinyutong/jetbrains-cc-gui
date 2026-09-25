package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonObject;
import com.github.claudecodegui.util.PathUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.nio.charset.StandardCharsets;

/**
 * Shared utility methods used across Claude bridge classes.
 * Eliminates duplication of common operations like env construction,
 * working directory resolution, and stdin writing.
 */
final class ClaudeBridgeUtils {

    private static final Logger LOG = Logger.getInstance(ClaudeBridgeUtils.class);

    private ClaudeBridgeUtils() {
    }

    /**
     * Build the environment variables block sent to the daemon process.
     * Used by both {@link ClaudeDaemonCoordinator} and {@link ClaudeDaemonRequestExecutor}.
     */
    static JsonObject buildDaemonEnv(String cwd) {
        return buildDaemonEnv(cwd, null);
    }

    /**
     * Build the environment variables block sent to the daemon process.
     * Includes envFile when non-null/non-empty.
     *
     * <p>{@code IDEA_PROJECT_PATH} / {@code PROJECT_PATH} are set from
     * {@link #resolveBaseDir(String)} — the same value the request params carry
     * under {@code cwd}. Both must stay identical: the Node side treats a missing
     * {@code cwd} as "fall back to the env var", so if one carries a path and the
     * other does not, the env-file base directory silently changes between the
     * preconnect and the send.
     */
    static JsonObject buildDaemonEnv(String cwd, String envFile) {
        JsonObject envVars = new JsonObject();
        envVars.addProperty("CLAUDE_USE_STDIN", "true");
        String baseDir = resolveBaseDir(cwd);
        if (baseDir != null) {
            envVars.addProperty("IDEA_PROJECT_PATH", baseDir);
            envVars.addProperty("PROJECT_PATH", baseDir);
        } else {
            LOG.debug("[ClaudeBridgeUtils.buildDaemonEnv] no valid cwd — omitting IDEA_PROJECT_PATH (value=" + cwd + ")");
        }
        if (envFile != null && !envFile.isEmpty() && !"null".equals(envFile) && !"undefined".equals(envFile)) {
            envVars.addProperty("envFile", envFile);
        } else {
            LOG.debug("[ClaudeBridgeUtils.buildDaemonEnv] envFile is null/empty/\"null\"/\"undefined\" (value=" + envFile + ")");
        }
        return envVars;
    }

    /**
     * Normalize a working directory into the single form sent over the wire, or
     * {@code null} when there is no usable project directory.
     *
     * <p>This is the authoritative "do we have a cwd?" predicate. Callers must not
     * substitute {@code ""} for {@code null}: an empty string is a real JSON value
     * that reads as "the empty directory" on the Node side, whereas an omitted
     * {@code cwd} is unambiguously "unknown" and lets the bridge fall back to
     * {@code IDEA_PROJECT_PATH}.
     */
    static String resolveBaseDir(String cwd) {
        if (!isValidCwd(cwd)) {
            return null;
        }
        String normalized = PathUtils.normalizeAbsolute(cwd.trim());
        if (normalized == null || normalized.isEmpty()) {
            return null;
        }
        return normalized;
    }

    /**
     * Resolve the effective working directory for a Node.js process.
     * Prefers the user-supplied {@code cwd} when it exists and is a directory;
     * falls back to {@code defaultDir} otherwise.
     */
    static File resolveWorkingDirectory(File defaultDir, String cwd) {
        if (isValidCwd(cwd)) {
            File userWorkDir = new File(cwd);
            if (userWorkDir.exists() && userWorkDir.isDirectory()) {
                return userWorkDir;
            }
        }
        return defaultDir;
    }

    /**
     * Write a JSON payload to the stdin of a child process, then close the stream.
     * Failures are silently ignored (the process will fail to read stdin and exit).
     */
    static void writeStdin(String stdinJson, Process process) {
        writeStdin(stdinJson, process, null, null);
    }

    /**
     * Write a JSON payload to the stdin of a child process with optional logging on failure.
     */
    static void writeStdin(String stdinJson, Process process, Logger log, String logPrefix) {
        try (java.io.OutputStream stdin = process.getOutputStream()) {
            stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
            stdin.flush();
        } catch (Exception e) {
            if (log != null && logPrefix != null) {
                log.warn(logPrefix + " Failed to write stdin: " + e.getMessage());
            }
        }
    }

    /**
     * Single source of truth for "is this a usable working directory?".
     * Package-private so the request params builder applies the same rule to the
     * {@code cwd} property it puts on the wire.
     */
    static boolean isValidCwd(String cwd) {
        return cwd != null && !cwd.isEmpty() && !"undefined".equals(cwd) && !"null".equals(cwd);
    }
}

package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.util.PathUtils;

/**
 * Shared helpers for resolving the project directory a relative env file path is
 * anchored to.
 *
 * <p>Every provider bridge used to resolve a relative env file path against
 * {@code new java.io.File(envFile)}, which silently anchors it to the JVM
 * process working directory — the IDE install directory or wherever the IDE was
 * launched from. The same string then meant a different file depending on the
 * launch method, and on some setups the path could land outside the project
 * entirely. Relative env file paths are always project-relative; this class is the
 * single place that decides what "the project directory" means for them.
 */
public final class EnvFileResolver {

    private EnvFileResolver() {
    }

    /**
     * Resolve the project directory used as the base for relative env file paths.
     *
     * <p>{@code null} is returned for missing/blank input and for the
     * {@code "null"}/{@code "undefined"} sentinels the webview uses for "no cwd".
     * With no project directory there is no valid base, and callers must refuse to
     * load a relative env file rather than guess one.
     *
     * <p>Existence is deliberately not required: the raw path is normalized
     * lexically so WSL UNC paths (which {@link PathUtils#normalizeAbsolute}
     * special-cases) are never round-tripped through {@link File}, and existence is
     * re-checked by the Node-side loader, which is the authority for whether a
     * path may be read.
     *
     * @param cwd the session working directory (the project directory, or a
     *            sub-directory of it)
     * @return the normalized absolute project directory, or {@code null}
     */
    public static String resolveProjectDir(String cwd) {
        if (cwd == null || cwd.isEmpty() || "null".equals(cwd) || "undefined".equals(cwd)) {
            return null;
        }
        String normalized = PathUtils.normalizeAbsolute(cwd.trim());
        if (normalized == null || normalized.isEmpty()) {
            return null;
        }
        return normalized;
    }
}

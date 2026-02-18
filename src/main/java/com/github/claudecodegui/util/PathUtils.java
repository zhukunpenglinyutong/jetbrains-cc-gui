package com.github.claudecodegui.util;

import com.github.claudecodegui.model.PathCheckResult;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Path utility class.
 * Provides cross-platform path handling methods including path normalization,
 * path validation, and temporary directory detection.
 */
public class PathUtils {

    // Windows path length limit
    private static final int WINDOWS_MAX_PATH = 260;
    private static final int SAFE_PATH_LENGTH = 200; // Leave room for file names

    // ==================== Path Normalization ====================

    /**
     * Convert a path into a safe filename/identifier.
     * Consistent with Claude Code's sanitizedPath logic.
     * Replaces all non-alphanumeric characters with hyphens.
     *
     * @param path the original path
     * @return the sanitized path string (non-alphanumeric characters replaced with -)
     */
    public static String sanitizePath(String path) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        // Consistent with Claude Code: replace all non-alphanumeric characters with -
        // e.g., D:\Projects\MyProject becomes D--Projects-MyProject
        return path.replaceAll("[^a-zA-Z0-9]", "-");
    }

    /**
     * Normalize a path to Unix style (for internal storage and comparison).
     * Converts Windows backslashes to forward slashes.
     *
     * @param path the original path
     * @return the path using forward slashes
     */
    public static String normalizeToUnix(String path) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        return path.replace("\\", "/");
    }

    /**
     * Normalize a path to the current platform's style.
     *
     * @param path the original path
     * @return the path using the current platform's separator
     */
    public static String normalizeToPlatform(String path) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        if (PlatformUtils.isWindows()) {
            return path.replace("/", "\\");
        } else {
            return path.replace("\\", "/");
        }
    }

    /**
     * Check whether a path is in Windows format (contains a drive letter).
     *
     * @param path the path to check
     * @return true if the path is in Windows format
     */
    public static boolean isWindowsPath(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        // Check if it starts with a drive letter (e.g., C:, D:)
        return path.matches("^[a-zA-Z]:.*");
    }

    /**
     * Check whether a path is a UNC path (network path).
     *
     * @param path the path to check
     * @return true if the path is a UNC path
     */
    public static boolean isUncPath(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        return path.startsWith("\\\\") || path.startsWith("//");
    }

    // ==================== Path Length Checks ====================

    /**
     * Check whether a path length is safe (primarily for Windows).
     *
     * @param path the path to check
     * @return PathCheckResult containing the check result and recommendations
     */
    public static PathCheckResult checkPathLength(String path) {
        if (path == null || path.isEmpty()) {
            return PathCheckResult.ok();
        }

        // No check needed on non-Windows platforms
        if (!PlatformUtils.isWindows()) {
            return PathCheckResult.ok();
        }

        int pathLength = path.length();

        if (pathLength >= WINDOWS_MAX_PATH) {
            return PathCheckResult.error(
                "Project path is too long (" + pathLength + " characters)\n" +
                "Windows limits path length to 260 characters.\n" +
                "Suggestion: move the project to a shorter path, e.g. D:\\projects\\",
                path,
                pathLength
            );
        }

        if (pathLength >= SAFE_PATH_LENGTH) {
            return PathCheckResult.warning(
                "Project path is relatively long (" + pathLength + " characters)\n" +
                "It may exceed the Windows path limit when creating deeply nested files.",
                path,
                pathLength
            );
        }

        return PathCheckResult.ok(path, pathLength);
    }

    // ==================== Temporary Directory Detection ====================

    /**
     * Get all possible temporary directory paths.
     *
     * @return list of temporary directory paths
     */
    public static List<String> getTempPaths() {
        Set<String> paths = new HashSet<>();

        // System temporary directory
        String javaTmpDir = System.getProperty("java.io.tmpdir");
        if (javaTmpDir != null && !javaTmpDir.isEmpty()) {
            paths.add(normalizeToUnix(javaTmpDir).toLowerCase());
        }

        if (PlatformUtils.isWindows()) {
            // Windows-specific temporary directories
            String temp = PlatformUtils.getEnvIgnoreCase("TEMP");
            if (temp != null && !temp.isEmpty()) {
                paths.add(normalizeToUnix(temp).toLowerCase());
            }

            String tmp = PlatformUtils.getEnvIgnoreCase("TMP");
            if (tmp != null && !tmp.isEmpty()) {
                paths.add(normalizeToUnix(tmp).toLowerCase());
            }

            String localAppData = PlatformUtils.getEnvIgnoreCase("LOCALAPPDATA");
            if (localAppData != null && !localAppData.isEmpty()) {
                paths.add(normalizeToUnix(localAppData + "\\Temp").toLowerCase());
            }

            // Common Windows temp directory
            paths.add("c:/windows/temp");
        } else {
            // Unix system temporary directories
            paths.add("/tmp");
            paths.add("/var/tmp");
            paths.add("/private/tmp"); // macOS

            String tmpDir = System.getenv("TMPDIR");
            if (tmpDir != null && !tmpDir.isEmpty()) {
                paths.add(normalizeToUnix(tmpDir).toLowerCase());
            }
        }

        return new ArrayList<>(paths);
    }

    /**
     * Check whether a given path is a temporary directory.
     *
     * @param path the path to check
     * @return true if the path is a temp directory or is located within one
     */
    public static boolean isTempDirectory(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }

        String normalizedPath = normalizeToUnix(path).toLowerCase();
        List<String> tempPaths = getTempPaths();

        for (String tempPath : tempPaths) {
            if (tempPath != null && normalizedPath.startsWith(tempPath)) {
                return true;
            }
        }

        return false;
    }

    // ==================== Path Validation ====================

    /**
     * Check whether a path is writable.
     *
     * @param path the path to verify
     * @return true if the path exists and is writable
     */
    public static boolean isWritable(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        File file = new File(path);
        return file.exists() && file.canWrite();
    }

    /**
     * Check whether a path exists.
     *
     * @param path the path to verify
     * @return true if the path exists
     */
    public static boolean exists(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        return new File(path).exists();
    }

    /**
     * Get the parent directory of a path.
     *
     * @param path the file or directory path
     * @return the parent directory path, or null if unavailable
     */
    public static String getParentPath(String path) {
        if (path == null || path.isEmpty()) {
            return null;
        }
        File file = new File(path);
        File parent = file.getParentFile();
        return parent != null ? parent.getAbsolutePath() : null;
    }

    /**
     * Join two path segments.
     *
     * @param basePath the base path
     * @param relativePath the relative path to append
     * @return the combined path
     */
    public static String joinPath(String basePath, String relativePath) {
        if (basePath == null || basePath.isEmpty()) {
            return relativePath;
        }
        if (relativePath == null || relativePath.isEmpty()) {
            return basePath;
        }
        return new File(basePath, relativePath).getAbsolutePath();
    }
}

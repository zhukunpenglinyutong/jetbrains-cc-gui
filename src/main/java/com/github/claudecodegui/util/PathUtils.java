package com.github.claudecodegui.util;

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

    /**
     * Convert an MSYS2/Git Bash-style path to a Windows path.
     * Handles the following path mappings:
     * <ul>
     *   <li>{@code /c/Users/test} → {@code C:\Users\test} (drive letter mapping)</li>
     *   <li>{@code /home/user} or {@code ~} → {@code %USERPROFILE%} (home directory)</li>
     *   <li>{@code /tmp} → {@code %TEMP%} (temporary directory)</li>
     *   <li>{@code /dev/null} → {@code NUL} (null device)</li>
     * </ul>
     * Returns the original path if conversion is not needed.
     *
     * @param path the original path
     * @return the converted Windows path, or the original path
     */
    public static String convertMsysToWindowsPath(String path) {
        if (path == null || path.isEmpty() || !PlatformUtils.isWindows()) {
            return path;
        }

        if (isWindowsPath(path) || isUncPath(path)) {
            return path;
        }

        // Handle tilde (home directory shorthand)
        if (path.equals("~") || path.startsWith("~/")) {
            String home = PlatformUtils.getHomeDirectory();
            if (home != null && !home.isEmpty()) {
                String expanded = path.equals("~") ? home : home + path.substring(1);
                return normalizeToPlatform(expanded);
            }
        }

        // All remaining conversions require a leading slash
        if (!path.startsWith("/")) {
            return path;
        }

        // /dev/null → NUL
        if (path.equals("/dev/null")) {
            return "NUL";
        }

        // Drive letter mapping: /c/... → C:\...
        if (path.matches("^/[a-zA-Z](/.*)?$")) {
            char driveLetter = Character.toUpperCase(path.charAt(1));
            String remainder = path.length() > 2 ? path.substring(2) : "";
            String windowsPath = driveLetter + ":" + (remainder.isEmpty() ? "/" : remainder);
            return normalizeToPlatform(windowsPath);
        }

        // /home/<username>/... → %USERPROFILE%/... (Git Bash maps /home/<user> to Windows home)
        if (path.startsWith("/home/")) {
            String home = PlatformUtils.getHomeDirectory();
            if (home != null && !home.isEmpty()) {
                String afterHome = path.substring("/home/".length());
                int slashIdx = afterHome.indexOf('/');
                if (slashIdx < 0) {
                    return normalizeToPlatform(home);
                } else {
                    return normalizeToPlatform(home + afterHome.substring(slashIdx));
                }
            }
        }

        // /tmp → system temp directory
        if (path.equals("/tmp") || path.startsWith("/tmp/")) {
            String tempDir = PlatformUtils.getTempDirectory();
            if (!tempDir.isEmpty()) {
                String remainder = path.length() > "/tmp".length() ? path.substring("/tmp".length()) : "";
                return normalizeToPlatform(tempDir + remainder);
            }
        }

        return path;
    }

    // ==================== Temporary Directory Detection ====================

    /**
     * Get all possible temporary directory paths.
     *
     * @return list of temporary directory paths
     */
    public static List<String> getTempPaths() {
        Set<String> paths = new HashSet<>();

        // Primary temp directory from PlatformUtils (handles TEMP/TMP/TMPDIR/java.io.tmpdir)
        String primaryTemp = PlatformUtils.getTempDirectory();
        if (!primaryTemp.isEmpty()) {
            paths.add(normalizeToUnix(primaryTemp).toLowerCase());
        }

        // java.io.tmpdir as additional fallback
        String javaTmpDir = System.getProperty("java.io.tmpdir");
        if (javaTmpDir != null && !javaTmpDir.isEmpty()) {
            paths.add(normalizeToUnix(javaTmpDir).toLowerCase());
        }

        if (PlatformUtils.isWindows()) {
            String localAppData = PlatformUtils.getEnvIgnoreCase("LOCALAPPDATA");
            if (localAppData != null && !localAppData.isEmpty()) {
                paths.add(normalizeToUnix(localAppData + "\\Temp").toLowerCase());
            }
        } else {
            paths.add("/tmp");
            paths.add("/var/tmp");
            paths.add("/private/tmp"); // macOS
        }

        return new ArrayList<>(paths);
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

}

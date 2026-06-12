package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** WSL path utilities: pure path-string conversions and WSL-home lookups. */
public final class WslPathUtil {

    private static final Logger LOG = Logger.getInstance(WslPathUtil.class);

    /** Cached result of {@link #resolveWslHomeUncPath()} — populated on first call. */
    private static volatile String cachedWslHomeUncPath = null;

    private WslPathUtil() {
    }

    /** Returns true if {@code path} is a Linux-style absolute path on a Windows host (i.e. starts with '/'). */
    public static boolean isWslPath(String path) {
        return PlatformUtils.isWindows()
                && path != null
                && !path.isEmpty()
                && path.charAt(0) == '/';
    }

    /** Converts a Windows or UNC path to its Linux form (e.g. {@code C:\x} to {@code /mnt/c/x}, {@code \\wsl.localhost\Ubuntu\home\x} to {@code /home/x}). */
    public static String convertToWslPath(String windowsPath) {
        if (windowsPath == null || windowsPath.isEmpty()) {
            return windowsPath;
        }
        // UNC WSL path: \\wsl.localhost\<distro>\<path>, \\wsl$\<distro>\<path>,
        // or their forward-slash forms (IntelliJ's project.getBasePath() returns
        // forward slashes when the project lives on the WSL filesystem).
        // Checked before the "already Unix" guard so //wsl.localhost/... is stripped.
        if (windowsPath.startsWith("\\\\wsl") || windowsPath.startsWith("//wsl")) {
            String normalized = windowsPath.replace('\\', '/');
            int distroNameStart = normalized.indexOf('/', 2);        // index of '/' before <distro>
            if (distroNameStart > 0) {
                int distroPathStart = normalized.indexOf('/', distroNameStart + 1); // index of '/' after <distro>
                if (distroPathStart > 0) {
                    return normalized.substring(distroPathStart);    // /home/...
                }
            }
        }
        // Already a Unix path
        if (windowsPath.charAt(0) == '/') {
            return windowsPath;
        }
        // Drive letter path: C:\Users\... -> /mnt/c/Users/...
        if (windowsPath.length() >= 2 && windowsPath.charAt(1) == ':') {
            char drive = Character.toLowerCase(windowsPath.charAt(0));
            String rest = windowsPath.substring(2).replace('\\', '/');
            // Ensure separator between drive letter and remainder for inputs like "C:Users\foo"
            if (rest.isEmpty() || rest.charAt(0) != '/') {
                rest = "/" + rest;
            }
            return "/mnt/" + drive + rest;
        }
        // Fallback: just replace backslashes
        return windowsPath.replace('\\', '/');
    }

    /** Converts a Linux absolute path to its Windows UNC form (e.g. {@code /home/x} to {@code \\wsl.localhost\Ubuntu\home\x}). */
    public static String convertWslPathToWindowsUnc(String wslPath) {
        if (!PlatformUtils.isWindows() || wslPath == null || wslPath.isEmpty() || wslPath.charAt(0) != '/') {
            return null;
        }
        String uncHome = resolveWslHomeUncPath();
        if (uncHome == null) {
            return null;
        }
        // Split "\\wsl.localhost\Ubuntu\..." to extract \\host\distro\ prefix.
        String[] parts = uncHome.split("\\\\");
        if (parts.length < 4 || parts[2].isEmpty() || parts[3].isEmpty()) {
            return null;
        }
        String distroRoot = "\\\\" + parts[2] + "\\" + parts[3] + "\\";
        String windowsTail = wslPath.replace('/', '\\');
        if (windowsTail.startsWith("\\")) {
            windowsTail = windowsTail.substring(1);
        }
        return distroRoot + windowsTail;
    }

    /** Returns path in forward-slash form that JetBrains {@code LocalFileSystem#refreshAndFindFileByPath} can resolve on this OS. */
    public static String toVfsPath(String path) {
        if (path == null) {
            return null;
        }
        if (PlatformUtils.isWindows()) {
            String unc = convertWslPathToWindowsUnc(path);
            if (unc != null) {
                return unc.replace('\\', '/');
            }
        }
        return path.replace('\\', '/');
    }

    /**
     * Checks if a file exists in WSL by running {@code wsl -e test -f <wslPath>}.
     * Use this as a fallback when {@code File.exists()} returns false for a WSL UNC path on Windows —
     * the UNC filesystem service can be slow to respond, causing spurious false negatives.
     */
    public static boolean wslFileExists(String wslPath) {
        if (!PlatformUtils.isWindows() || wslPath == null || wslPath.isEmpty() || wslPath.charAt(0) != '/') {
            return false;
        }
        try {
            ProcessBuilder pb = new ProcessBuilder("wsl", "-e", "test", "-f", wslPath);
            pb.redirectErrorStream(true);
            Process p = pb.start();
            boolean finished = p.waitFor(3, TimeUnit.SECONDS);
            if (!finished) {
                p.destroyForcibly();
                return false;
            }
            return p.exitValue() == 0;
        } catch (Exception e) {
            LOG.debug("[WslPathUtil] wslFileExists check failed for " + wslPath + ": " + e.getMessage());
            return false;
        }
    }

    /** Returns true if {@code filePath} is inside {@code basePath}, normalizing WSL Linux paths correctly on Windows. */
    public static boolean isPathWithinDirectory(String filePath, String basePath) {
        if (filePath == null || filePath.isEmpty() || basePath == null) {
            return false;
        }
        // Only WSL Linux paths on a Windows JVM (e.g. "/home/x", or "//wsl$/..." which
        // convertToWslPath folds to it) need the lexical fallback: getCanonicalPath would
        // misread "/home/x" as a drive-relative path there. Every other path — native POSIX
        // paths on macOS/Linux, and Windows drive/UNC paths — MUST go through getCanonicalPath
        // so symlinks, "..", and encoded chars are resolved before the project-boundary check.
        // Using foldPosix for native POSIX paths silently strips symlink resolution and lets a
        // symlink inside the project escape the boundary, weakening the auto-approve gate.
        if (isWslPath(filePath) || isWslPath(basePath)) {
            String normalizedFile = foldPosix(convertToWslPath(filePath));
            String normalizedBase = foldPosix(convertToWslPath(basePath));
            if (normalizedFile == null || normalizedBase == null) {
                return false;
            }
            String basePrefix = normalizedBase.endsWith("/") ? normalizedBase : normalizedBase + "/";
            return normalizedFile.equals(normalizedBase) || normalizedFile.startsWith(basePrefix);
        }
        try {
            // Use canonical path to resolve symlinks, "..", encoded chars on native local paths.
            String canonicalFile = new File(filePath).getCanonicalPath();
            String canonicalBase = new File(basePath).getCanonicalPath();
            return canonicalFile.startsWith(canonicalBase + File.separator) || canonicalFile.equals(canonicalBase);
        } catch (IOException e) {
            return false;
        }
    }

    /** Resolves "." and ".." in an absolute POSIX path. Returns {@code null} if the path escapes above root. */
    public static String foldPosix(String path) {
        if (path == null || path.isEmpty() || path.charAt(0) != '/') {
            return null;
        }
        Deque<String> stack = new ArrayDeque<>();
        for (String segment : path.split("/")) {
            if (segment.isEmpty() || ".".equals(segment)) {
                continue;
            }
            if ("..".equals(segment)) {
                if (stack.isEmpty()) {
                    return null; // attempt to traverse above the filesystem root
                }
                stack.removeLast();
            } else {
                stack.addLast(segment);
            }
        }
        if (stack.isEmpty()) {
            return "/";
        }
        StringBuilder sb = new StringBuilder();
        for (String segment : stack) {
            sb.append('/').append(segment);
        }
        return sb.toString();
    }

    /** Returns the WSL home as a Windows UNC path (e.g. {@code \\wsl.localhost\Ubuntu\home\alice}); runs {@code wslpath -w $HOME} once and caches the result. */
    public static String resolveWslHomeUncPath() {
        if (!PlatformUtils.isWindows()) {
            return null;
        }
        if (cachedWslHomeUncPath != null) {
            return cachedWslHomeUncPath;
        }
        synchronized (WslPathUtil.class) {
            if (cachedWslHomeUncPath != null) {
                return cachedWslHomeUncPath;
            }
            try {
                ProcessBuilder pb = new ProcessBuilder("wsl", "sh", "-c", "wslpath -w $HOME");
                pb.redirectErrorStream(true);
                Process process = pb.start();
                String line = null;
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    line = reader.readLine();
                }
                boolean finished = process.waitFor(5, TimeUnit.SECONDS);
                if (finished && process.exitValue() == 0
                        && line != null && line.trim().startsWith("\\\\")) {
                    cachedWslHomeUncPath = line.trim();
                    LOG.info("[WslPathUtil] Resolved WSL home UNC path: " + cachedWslHomeUncPath);
                }
            } catch (Exception e) {
                LOG.warn("[WslPathUtil] Failed to resolve WSL home UNC path: " + e.getMessage());
            }
        }
        return cachedWslHomeUncPath;
    }

    /** Returns the WSL home (forward-slash UNC) when {@code nodePath} is a WSL binary, otherwise the native OS home. */
    public static String resolveHomeForFileOps(String nodePath) {
        if (isWslPath(nodePath)) {
            String wslHomeUnc = resolveWslHomeUncPath();
            if (wslHomeUnc != null && !wslHomeUnc.isEmpty()) {
                return wslHomeUnc.replace('\\', '/');
            }
        }
        return PlatformUtils.getHomeDirectory();
    }

    /** Builds a WSL-aware {@code [wsl] node <scriptPath>} command list; prepends {@code wsl} and converts scriptPath when {@code nodePath} is a WSL path. */
    public static List<String> buildNodeScriptCommand(String nodePath, String scriptPath) {
        List<String> command = new ArrayList<>();
        if (isWslPath(nodePath)) {
            command.add("wsl");
            command.add(nodePath);
            command.add(convertToWslPath(scriptPath));
        } else {
            command.add(nodePath);
            command.add(scriptPath);
        }
        return command;
    }

    /** Builds a WSL-aware {@code [wsl] node -e <scriptBody>} command list; prepends {@code wsl} when {@code nodePath} is a WSL path. */
    public static List<String> buildNodeInlineCommand(String nodePath, String scriptBody) {
        List<String> command = new ArrayList<>();
        if (isWslPath(nodePath)) {
            command.add("wsl");
        }
        command.add(nodePath);
        command.add("-e");
        command.add(scriptBody);
        return command;
    }

    /** Returns {@code path} as a Linux form (via {@link #convertToWslPath}) on WSL, or with backslashes doubled for safe inline JS embedding otherwise. */
    public static String resolveScriptPath(String nodePath, String path) {
        return isWslPath(nodePath) ? convertToWslPath(path) : path.replace("\\", "\\\\");
    }
}

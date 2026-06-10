package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Detects and verifies the Claude CLI executable.
 */
public class ClaudeCliDetector {

    private static final Logger LOG = Logger.getInstance(ClaudeCliDetector.class);

    private static final String[] WINDOWS_CLI_PATHS = {
            "%USERPROFILE%\\.claude\\local\\claude.exe",
            "%USERPROFILE%\\.claude\\local\\claude",
            "%LOCALAPPDATA%\\Programs\\claude\\claude.exe",
    };

    private static final String[] UNIX_CLI_PATHS = {
            "/usr/local/bin/claude",
            "/opt/homebrew/bin/claude",
    };

    private static volatile ClaudeCliDetector instance;
    private static final Object lock = new Object();

    private volatile String cachedCliPath;
    private volatile String cachedCliVersion;
    private volatile boolean detectionAttempted;

    private ClaudeCliDetector() {
    }

    public static ClaudeCliDetector getInstance() {
        if (instance == null) {
            synchronized (lock) {
                if (instance == null) {
                    instance = new ClaudeCliDetector();
                }
            }
        }
        return instance;
    }

    public String findCliExecutable() {
        if (cachedCliPath != null) {
            return cachedCliPath;
        }
        if (detectionAttempted) {
            return null;
        }
        synchronized (this) {
            if (cachedCliPath != null) {
                return cachedCliPath;
            }
            if (detectionAttempted) {
                return null;
            }
            String path = detectCliPath();
            detectionAttempted = true;
            if (path != null) {
                cachedCliPath = path;
                LOG.info("[ClaudeCliDetector] Detected Claude CLI: " + path);
            } else {
                LOG.warn("[ClaudeCliDetector] Claude CLI executable not found");
            }
            return path;
        }
    }

    private String detectCliPath() {
        List<String> triedPaths = new ArrayList<>();

        String configuredPath = detectViaConfiguredPath(triedPaths);
        if (configuredPath != null) {
            return configuredPath;
        }

        String cmdResult = detectViaSystemCommand(triedPaths);
        if (cmdResult != null) {
            return cmdResult;
        }

        String knownPath = detectViaKnownPaths(triedPaths);
        if (knownPath != null) {
            return knownPath;
        }

        String pathResult = detectViaPathVariable(triedPaths);
        if (pathResult != null) {
            return pathResult;
        }

        String fallback = detectViaFallback(triedPaths);
        if (fallback != null) {
            return fallback;
        }

        LOG.info("[ClaudeCliDetector] Tried paths: " + triedPaths);
        return null;
    }

    private String detectViaConfiguredPath(List<String> triedPaths) {
        try {
            String configuredPath = CodemossSettingsService.getInstance().getClaudeCliPath();
            if (configuredPath == null || configuredPath.trim().isEmpty()) {
                return null;
            }

            String normalizedPath = configuredPath.trim();
            triedPaths.add(normalizedPath);
            String version = verifyCliPath(normalizedPath);
            if (version != null) {
                cachedCliVersion = version;
                LOG.info("[ClaudeCliDetector] Using configured Claude CLI path: " + normalizedPath + " (" + version + ")");
                return normalizedPath;
            }

            LOG.warn("[ClaudeCliDetector] Configured Claude CLI path is invalid: " + normalizedPath);
        } catch (Exception e) {
            LOG.debug("[ClaudeCliDetector] Failed to read configured Claude CLI path: " + e.getMessage());
        }
        return null;
    }

    private String detectViaSystemCommand(List<String> triedPaths) {
        try {
            ProcessBuilder pb = PlatformUtils.isWindows()
                    ? new ProcessBuilder("where", "claude")
                    : new ProcessBuilder("which", "claude");
            Process process = pb.start();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String path = reader.readLine();
                if (path != null && !path.isEmpty()) {
                    path = path.trim();
                    triedPaths.add(path);

                    if (PlatformUtils.isWindows()) {
                        String cmdPath = pickWindowsCmd(reader, path);
                        if (cmdPath != null) {
                            path = cmdPath;
                        }
                    }

                    String version = verifyCliPath(path);
                    if (version != null) {
                        cachedCliVersion = version;
                        LOG.info("[ClaudeCliDetector] Found Claude via where/which: " + path + " (" + version + ")");
                        return path;
                    }
                }
            }
            boolean finished = process.waitFor(5, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
            }
        } catch (Exception e) {
            LOG.debug("[ClaudeCliDetector] where/which lookup failed: " + e.getMessage());
        }
        return null;
    }

    private String pickWindowsCmd(BufferedReader reader, String firstPath) throws Exception {
        if (firstPath.endsWith(".cmd")) {
            return firstPath;
        }
        String line;
        while ((line = reader.readLine()) != null) {
            line = line.trim();
            if (line.endsWith(".cmd")) {
                return line;
            }
        }
        return null;
    }

    private String detectViaKnownPaths(List<String> triedPaths) {
        String userHome = PlatformUtils.getHomeDirectory();
        String[] templates = PlatformUtils.isWindows() ? WINDOWS_CLI_PATHS : UNIX_CLI_PATHS;

        List<String> pathsToCheck = new ArrayList<>();
        for (String template : templates) {
            pathsToCheck.add(expandEnvVars(template));
        }

        if (PlatformUtils.isWindows()) {
            String appData = System.getenv("APPDATA");
            if (appData != null) {
                pathsToCheck.add(appData + "\\npm\\claude.cmd");
                pathsToCheck.add(appData + "\\npm\\claude.exe");
            }
        } else {
            pathsToCheck.add(userHome + "/.npm/bin/claude");
            String npmGlobalPrefix = detectNpmGlobalPrefix();
            if (npmGlobalPrefix != null) {
                pathsToCheck.add(npmGlobalPrefix + "/bin/claude");
            }
        }

        for (String path : pathsToCheck) {
            triedPaths.add(path);
            File file = new File(path);
            if (!file.exists()) {
                continue;
            }
            if (!PlatformUtils.isWindows() && !file.canExecute()) {
                continue;
            }
            String version = verifyCliPath(path);
            if (version != null) {
                cachedCliVersion = version;
                LOG.info("[ClaudeCliDetector] Found Claude in known path: " + path + " (" + version + ")");
                return path;
            }
        }
        return null;
    }

    private String detectViaPathVariable(List<String> triedPaths) {
        String pathEnv = PlatformUtils.isWindows()
                ? PlatformUtils.getEnvIgnoreCase("PATH")
                : System.getenv("PATH");
        if (pathEnv == null || pathEnv.isEmpty()) {
            return null;
        }
        String cliName = PlatformUtils.isWindows() ? "claude.cmd" : "claude";
        for (String dir : pathEnv.split(File.pathSeparator)) {
            if (dir == null || dir.isEmpty()) {
                continue;
            }
            File cliFile = new File(dir, cliName);
            String absPath = cliFile.getAbsolutePath();
            triedPaths.add(absPath);
            if (!cliFile.exists()) {
                continue;
            }
            String version = verifyCliPath(absPath);
            if (version != null) {
                cachedCliVersion = version;
                LOG.info("[ClaudeCliDetector] Found Claude in PATH: " + absPath + " (" + version + ")");
                return absPath;
            }
        }
        return null;
    }

    private String detectViaFallback(List<String> triedPaths) {
        triedPaths.add("claude");
        String version = verifyCliPath("claude");
        if (version != null) {
            cachedCliVersion = version;
            LOG.info("[ClaudeCliDetector] Direct Claude invocation succeeded (" + version + ")");
            return "claude";
        }
        return null;
    }

    public String verifyCliPath(String path) {
        try {
            ProcessBuilder pb = new ProcessBuilder(path, "--version");
            Process process = pb.start();
            String version;
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                version = reader.readLine();
            }
            boolean finished = process.waitFor(5, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return null;
            }
            if (process.exitValue() == 0 && version != null) {
                return version.trim();
            }
        } catch (Exception e) {
            LOG.debug("[ClaudeCliDetector] Verification failed [" + path + "]: " + e.getMessage());
        }
        return null;
    }

    /**
     * Sets the user-configured CLI path. Validates basic safety:
     * - must be absolute
     * - must point to a regular existing file (not a directory)
     * - on Unix must be executable
     * - file name must match the expected Claude CLI binary name
     * Invalid paths are rejected (cache stays unchanged + warning logged).
     * Pass null/blank to clear the cached path and force re-detection.
     * (PR #1191 review H2.)
     */
    public void setCliPath(String path) {
        synchronized (this) {
            if (path == null || path.isBlank()) {
                this.cachedCliPath = null;
                this.detectionAttempted = false;
                this.cachedCliVersion = null;
                return;
            }
            String trimmed = path.trim();
            if (!isValidCliPath(trimmed)) {
                LOG.warn("[ClaudeCliDetector] Rejected unsafe Claude CLI path: " + trimmed);
                return;
            }
            this.cachedCliPath = trimmed;
            this.detectionAttempted = true;
            this.cachedCliVersion = verifyCliPath(trimmed);
        }
    }

    /**
     * Lightweight whitelist check for user-supplied CLI paths. Designed to stop the
     * settings UI from accidentally pointing the detector at an arbitrary binary
     * (e.g. /bin/sh) and then having verifyCliPath() execute it.
     */
    static boolean isValidCliPath(String path) {
        if (path == null || path.isBlank()) {
            return false;
        }
        File file = new File(path);
        if (!file.isAbsolute() || !file.isFile()) {
            return false;
        }
        if (!PlatformUtils.isWindows() && !file.canExecute()) {
            return false;
        }
        String name = file.getName().toLowerCase(java.util.Locale.ROOT);
        // Accept "claude", "claude.cmd", "claude.exe", or "claude*.sh" style; reject everything else.
        return name.equals("claude")
                || name.equals("claude.cmd")
                || name.equals("claude.exe")
                || name.equals("claude.bat")
                || (name.startsWith("claude") && (name.endsWith(".cmd")
                        || name.endsWith(".exe")
                        || name.endsWith(".bat")
                        || name.endsWith(".sh")
                        || !name.contains(".")));
    }

    public String getCachedVersion() {
        return cachedCliVersion;
    }

    public void clearCache() {
        synchronized (this) {
            this.cachedCliPath = null;
            this.cachedCliVersion = null;
            this.detectionAttempted = false;
        }
    }

    private String expandEnvVars(String path) {
        if (path == null) {
            return null;
        }
        String result = path;
        result = result.replace("%USERPROFILE%", PlatformUtils.getHomeDirectory());
        result = result.replace("%APPDATA%", System.getenv("APPDATA") != null ? System.getenv("APPDATA") : "");
        result = result.replace("%LOCALAPPDATA%", System.getenv("LOCALAPPDATA") != null ? System.getenv("LOCALAPPDATA") : "");
        return result;
    }

    private String detectNpmGlobalPrefix() {
        try {
            ProcessBuilder pb = new ProcessBuilder("npm", "prefix", "-g");
            Process process = pb.start();
            String prefix;
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                prefix = reader.readLine();
            }
            boolean finished = process.waitFor(5, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return null;
            }
            if (process.exitValue() == 0 && prefix != null && !prefix.isEmpty()) {
                return prefix.trim();
            }
        } catch (Exception ignored) {
        }
        return null;
    }
}

package com.github.claudecodegui.bridge;

import com.github.claudecodegui.model.CliDetectionResult;
import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.ShellExecutor;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Claude Code CLI detector.
 * Responsible for locating and verifying the Claude Code CLI executable across various platforms.
 * Implemented as a singleton to share cache across the application.
 */
public class CLIDetector {

    private static final Logger LOG = Logger.getInstance(CLIDetector.class);

    // Common CLI installation paths on Windows
    private static final String[] WINDOWS_CLI_PATHS = {
            // npm global installation
            "%APPDATA%\\npm\\claude.cmd",
            "%APPDATA%\\npm\\claude-code.cmd",
            // Custom user installation
            "%USERPROFILE%\\.claude-code\\bin\\claude.cmd",
            "%USERPROFILE%\\.claude\\bin\\claude.cmd"
    };

    // Common CLI installation paths on macOS/Linux
    private static final String[] UNIX_CLI_PATHS = {
            "~/.local/bin/claude",
            "/usr/local/bin/claude",
            "/opt/homebrew/bin/claude",
            "~/.npm-global/bin/claude",
            "~/.config/nvm/current/bin/claude",
            "~/.claude-code/bin/claude",
            "~/.claude/bin/claude"
    };

    // ============================================================================
    // Singleton Implementation
    // ============================================================================

    private static volatile CLIDetector instance;
    private static final Object lock = new Object();

    /** Private constructor to enforce singleton pattern. */
    private CLIDetector() {
    }

    /**
     * Get the singleton instance of CLIDetector.
     *
     * @return shared CLIDetector instance
     */
    public static CLIDetector getInstance() {
        if (instance == null) {
            synchronized (lock) {
                if (instance == null) {
                    instance = new CLIDetector();
                }
            }
        }
        return instance;
    }

    // ============================================================================
    // Instance Fields
    // ============================================================================

    private volatile String cachedCliExecutable = null;
    private volatile CliDetectionResult cachedDetectionResult = null;
    private final Object cacheLock = new Object();

    /**
     * Finds Claude Code CLI executable path.
     */
    public String findCliExecutable() {
        if (this.cachedCliExecutable != null) {
            return this.cachedCliExecutable;
        }

        synchronized (this.cacheLock) {
            if (this.cachedCliExecutable != null) {
                return this.cachedCliExecutable;
            }

            CliDetectionResult result = detectCliWithDetails();
            if (result != null && result.isFound()) {
                this.cachedDetectionResult = result;
                this.cachedCliExecutable = result.getCliPath();
                return this.cachedCliExecutable;
            }

            LOG.warn("⚠️ 无法自动检测 Claude Code CLI 路径");
            this.cachedCliExecutable = "claude";
            return this.cachedCliExecutable;
        }
    }

    /**
     * Detects Claude Code CLI and returns a detailed result.
     *
     * @return CliDetectionResult containing detection details
     */
    public CliDetectionResult detectCliWithDetails() {
        List<String> triedPaths = new ArrayList<>();
        LOG.info("正在查找 Claude Code CLI...");
        LOG.info("  操作系统: " + System.getProperty("os.name"));
        LOG.info("  平台类型: " + (PlatformUtils.isWindows() ? "Windows" :
                                               (PlatformUtils.isMac() ? "macOS" : "Linux/Unix")));

        // 1. Try locating via system commands (where/which)
        CliDetectionResult cmdResult = detectCliViaSystemCommand(triedPaths);
        if (cmdResult != null && cmdResult.isFound()) {
            return cmdResult;
        }

        // 2. Try known installation paths
        CliDetectionResult knownPathResult = detectCliViaKnownPaths(triedPaths);
        if (knownPathResult != null && knownPathResult.isFound()) {
            return knownPathResult;
        }

        // 3. Try PATH environment variable
        CliDetectionResult pathResult = detectCliViaPath(triedPaths);
        if (pathResult != null && pathResult.isFound()) {
            return pathResult;
        }

        return CliDetectionResult.failure("在所有已知路径中均未找到 Claude Code CLI", triedPaths);
    }

    /**
     * Detects CLI via system commands (where/which).
     */
    private CliDetectionResult detectCliViaSystemCommand(List<String> triedPaths) {
        if (PlatformUtils.isWindows()) {
            return detectCliViaWindowsWhere(triedPaths);
        } else {
            // macOS/Linux: try zsh first (macOS default), then bash
            CliDetectionResult result = detectCliViaShell("/bin/zsh", "zsh", triedPaths);
            if (result != null && result.isFound()) {
                return result;
            }
            return detectCliViaShell("/bin/bash", "bash", triedPaths);
        }
    }

    /**
     * Windows: detects CLI using "where" command.
     */
    private CliDetectionResult detectCliViaWindowsWhere(List<String> triedPaths) {
        try {
            // Try both "claude" and "claude-code"
            for (String cliName : new String[]{"claude", "claude-code"}) {
                ProcessBuilder pb = new ProcessBuilder("where", cliName);
                String methodDesc = "Windows where 命令 (" + cliName + ")";

                LOG.info("  尝试方法: " + methodDesc);
                Process process = pb.start();

                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String path = reader.readLine();
                    if (path != null && !path.isEmpty()) {
                        path = path.trim();
                        triedPaths.add(path);

                        String version = verifyCliPath(path);
                        if (version != null) {
                            LOG.info("✓ 通过 " + methodDesc + " 找到 CLI: " + path + " (" + version + ")");
                            return CliDetectionResult.success(
                                    path, version,
                                    CliDetectionResult.DetectionMethod.WHERE_COMMAND,
                                    triedPaths
                            );
                        }
                    }
                }

                boolean finished = process.waitFor(5, TimeUnit.SECONDS);
                if (!finished) {
                    process.destroyForcibly();
                }
            }
        } catch (Exception e) {
            LOG.debug("  Windows where 命令查找失败: " + e.getMessage());
        }
        return null;
    }

    /**
     * Unix/macOS: detects CLI through a specified shell.
     */
    private CliDetectionResult detectCliViaShell(String shellPath, String shellName, List<String> triedPaths) {
        if (!new File(shellPath).exists()) {
            LOG.debug("  跳过 " + shellName + "（不存在）");
            return null;
        }

        String methodDesc = shellName + " which 命令（登录+交互式 shell）";
        LOG.info("  尝试方法: " + methodDesc);

        List<String> command = new ArrayList<>();
        command.add(shellPath);
        command.add("-l");
        command.add("-i");
        command.add("-c");
        command.add("which claude || which claude-code");

        ShellExecutor.ExecutionResult result = ShellExecutor.execute(
                command,
                ShellExecutor.createCliPathFilter(),
                "  " + shellName,
                ShellExecutor.DEFAULT_TIMEOUT_SECONDS,
                true
        );

        if (result.isSuccess() && result.getOutput() != null) {
            String cliPath = result.getOutput();
            triedPaths.add(cliPath);

            String version = verifyCliPath(cliPath);
            if (version != null) {
                LOG.info("✓ 通过 " + methodDesc + " 找到 CLI: " + cliPath + " (" + version + ")");
                return CliDetectionResult.success(
                        cliPath, version,
                        CliDetectionResult.DetectionMethod.WHICH_COMMAND,
                        triedPaths
                );
            }
        }

        return null;
    }

    /**
     * Detects CLI by checking known installation paths.
     */
    private CliDetectionResult detectCliViaKnownPaths(List<String> triedPaths) {
        String userHome = PlatformUtils.getHomeDirectory();
        List<String> pathsToCheck = new ArrayList<>();

        if (PlatformUtils.isWindows()) {
            LOG.info("  正在检查 Windows 常见安装路径...");
            for (String templatePath : WINDOWS_CLI_PATHS) {
                String expandedPath = expandWindowsEnvVars(templatePath);
                pathsToCheck.add(expandedPath);
            }
        } else {
            LOG.info("  正在检查 Unix/macOS 常见安装路径...");
            for (String templatePath : UNIX_CLI_PATHS) {
                String expandedPath = expandUnixTilde(templatePath);
                pathsToCheck.add(expandedPath);
            }
        }

        // Check each path (directly verify without existence check to avoid TOCTOU)
        for (String path : pathsToCheck) {
            triedPaths.add(path);

            String version = verifyCliPath(path);
            if (version != null) {
                LOG.info("✓ 在已知路径找到 CLI: " + path + " (" + version + ")");
                return CliDetectionResult.success(path, version,
                        CliDetectionResult.DetectionMethod.KNOWN_PATH, triedPaths);
            }
        }

        return null;
    }

    /**
     * Detects CLI by scanning PATH environment variable.
     */
    private CliDetectionResult detectCliViaPath(List<String> triedPaths) {
        LOG.info("  正在检查 PATH 环境变量...");

        String pathEnv = PlatformUtils.isWindows() ?
                                 PlatformUtils.getEnvIgnoreCase("PATH") :
                                 System.getenv("PATH");

        if (pathEnv == null || pathEnv.isEmpty()) {
            LOG.debug("  PATH 环境变量为空");
            return null;
        }

        String[] paths = pathEnv.split(File.pathSeparator);
        String cliFileName = PlatformUtils.isWindows() ? "claude.cmd" : "claude";

        for (String dir : paths) {
            if (dir == null || dir.isEmpty()) continue;

            File cliFile = new File(dir, cliFileName);
            String cliPath = cliFile.getAbsolutePath();
            triedPaths.add(cliPath);

            String version = verifyCliPath(cliPath);
            if (version != null) {
                LOG.info("✓ 在 PATH 中找到 CLI: " + cliPath + " (" + version + ")");
                return CliDetectionResult.success(cliPath, version,
                        CliDetectionResult.DetectionMethod.PATH_VARIABLE, triedPaths);
            }
        }

        return null;
    }

    /**
     * Validates that a given path looks like a CLI binary.
     */
    private boolean isValidCliBinaryName(String path) {
        if (path == null || path.trim().isEmpty()) {
            return false;
        }
        if ("claude".equals(path) || "claude-code".equals(path)) {
            return true;
        }
        String name = new File(path).getName().toLowerCase();
        return name.equals("claude") || name.equals("claude.cmd") || name.equals("claude-code") || name.equals("claude-code.cmd");
    }

    /**
     * Verifies whether a CLI path is usable.
     *
     * @param path CLI executable path
     * @return version string if usable, otherwise null
     */
    public String verifyCliPath(String path) {
        if (!isValidCliBinaryName(path)) {
            LOG.warn("[CLIDetector] Rejected invalid CLI binary name: " + path);
            return null;
        }
        try {
            ProcessBuilder pb = new ProcessBuilder(path, "--version");
            Process process = pb.start();

            String version = null;
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                version = reader.readLine();
            }

            boolean finished = process.waitFor(10, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return null;
            }

            int exitCode = process.exitValue();
            if (exitCode == 0 && version != null) {
                return version.trim();
            }
        } catch (Exception e) {
            LOG.debug("    验证失败 [" + path + "]: " + e.getMessage());
        }
        return null;
    }

    /**
     * Expands Windows environment variables in a path.
     */
    private String expandWindowsEnvVars(String path) {
        if (path == null) return null;

        String result = path;
        result = result.replace("%USERPROFILE%", PlatformUtils.getHomeDirectory());
        result = result.replace("%APPDATA%", System.getenv("APPDATA") != null ?
                                                     System.getenv("APPDATA") : "");
        return result;
    }

    /**
     * Expands Unix tilde (~) in a path.
     */
    private String expandUnixTilde(String path) {
        if (path == null) return null;
        return path.replace("~", PlatformUtils.getHomeDirectory());
    }

    /**
     * Manually sets the CLI executable path.
     */
    public void setCliExecutable(String path) {
        synchronized (this.cacheLock) {
            this.cachedCliExecutable = path;
            if (path == null || this.cachedDetectionResult == null
                    || !path.equals(this.cachedDetectionResult.getCliPath())) {
                this.cachedDetectionResult = null;
            }
        }
    }

    /**
     * Get current CLI executable path.
     */
    public String getCliExecutable() {
        if (this.cachedCliExecutable == null) {
            return findCliExecutable();
        }
        return this.cachedCliExecutable;
    }

    /**
     * Clears the cached CLI path and detection result.
     */
    public void clearCache() {
        synchronized (this.cacheLock) {
            this.cachedCliExecutable = null;
            this.cachedDetectionResult = null;
        }
    }

    /**
     * Gets cached detection result.
     */
    public CliDetectionResult getCachedDetectionResult() {
        synchronized (this.cacheLock) {
            return this.cachedDetectionResult;
        }
    }

    /**
     * Gets the cached CLI executable path from the detection result.
     */
    public String getCachedCliPath() {
        synchronized (this.cacheLock) {
            if (this.cachedDetectionResult != null && this.cachedDetectionResult.getCliPath() != null) {
                return this.cachedDetectionResult.getCliPath();
            }
            return this.cachedCliExecutable;
        }
    }

    /**
     * Gets the cached CLI version string.
     */
    public String getCachedCliVersion() {
        synchronized (this.cacheLock) {
            return this.cachedDetectionResult != null ? this.cachedDetectionResult.getCliVersion() : null;
        }
    }

    /**
     * Verify and cache a CLI path.
     *
     * @param path CLI executable path to verify
     * @return CliDetectionResult with verification details
     */
    public CliDetectionResult verifyAndCacheCliPath(String path) {
        if (path == null || path.isEmpty()) {
            clearCache();
            return CliDetectionResult.failure("未指定 CLI 路径");
        }
        String version = verifyCliPath(path);
        CliDetectionResult result;
        if (version != null) {
            result = CliDetectionResult.success(path, version, CliDetectionResult.DetectionMethod.KNOWN_PATH);
        } else {
            result = CliDetectionResult.failure("无法验证指定的 CLI 路径: " + path);
        }
        cacheDetection(result);
        return result;
    }

    /**
     * Cache a detection result.
     */
    private void cacheDetection(CliDetectionResult result) {
        synchronized (this.cacheLock) {
            this.cachedDetectionResult = result;
            if (result != null && result.isFound() && result.getCliPath() != null) {
                this.cachedCliExecutable = result.getCliPath();
            }
        }
    }
}

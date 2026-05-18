package com.github.claudecodegui.provider.claude;

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
 * Claude CLI 二进制文件检测器。
 * 负责在系统中查找和验证 claude CLI 可执行文件。
 * 单例模式，参考 NodeDetector 实现。
 */
public class ClaudeCliDetector {

    private static final Logger LOG = Logger.getInstance(ClaudeCliDetector.class);

    // Windows 常见安装路径
    private static final String[] WINDOWS_CLI_PATHS = {
            "%USERPROFILE%\\.claude\\local\\claude.exe",
            "%USERPROFILE%\\.claude\\local\\claude",
            "%LOCALAPPDATA%\\Programs\\claude\\claude.exe",
    };

    // macOS/Linux 常见安装路径
    private static final String[] UNIX_CLI_PATHS = {
            "/usr/local/bin/claude",
            "/opt/homebrew/bin/claude",
    };

    // 单例
    private static volatile ClaudeCliDetector instance;
    private static final Object lock = new Object();

    // 缓存
    private volatile String cachedCliPath;
    private volatile String cachedCliVersion;
    private volatile boolean detectionAttempted;

    private ClaudeCliDetector() {}

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

    /**
     * 查找 claude CLI 可执行文件路径。
     * 优先使用缓存，然后尝试自动检测。
     */
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
                LOG.info("[ClaudeCliDetector] 检测到 claude CLI: " + path);
            } else {
                LOG.warn("[ClaudeCliDetector] 未找到 claude CLI 可执行文件");
            }
            return path;
        }
    }

    /**
     * 执行实际的 CLI 路径检测。
     */
    private String detectCliPath() {
        List<String> triedPaths = new ArrayList<>();

        // 1. 系统命令查找 (where/which)
        String cmdResult = detectViaSystemCommand(triedPaths);
        if (cmdResult != null) {
            return cmdResult;
        }

        // 2. 已知安装路径
        String knownPath = detectViaKnownPaths(triedPaths);
        if (knownPath != null) {
            return knownPath;
        }

        // 3. PATH 环境变量扫描
        String pathResult = detectViaPathVariable(triedPaths);
        if (pathResult != null) {
            return pathResult;
        }

        // 4. 回退：直接尝试 "claude"
        String fallback = detectViaFallback(triedPaths);
        if (fallback != null) {
            return fallback;
        }

        LOG.info("[ClaudeCliDetector] 尝试过的路径: " + triedPaths);
        return null;
    }

    private String detectViaSystemCommand(List<String> triedPaths) {
        try {
            ProcessBuilder pb;
            if (PlatformUtils.isWindows()) {
                pb = new ProcessBuilder("where", "claude");
            } else {
                pb = new ProcessBuilder("which", "claude");
            }
            Process process = pb.start();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String path = reader.readLine();
                if (path != null && !path.isEmpty()) {
                    path = path.trim();
                    triedPaths.add(path);

                    // Windows: 优先选择 .cmd 文件
                    if (PlatformUtils.isWindows()) {
                        String cmdPath = pickWindowsCmd(reader, path);
                        if (cmdPath != null) {
                            path = cmdPath;
                        }
                    }

                    String version = verifyCliPath(path);
                    if (version != null) {
                        cachedCliVersion = version;
                        LOG.info("[ClaudeCliDetector] 通过 where/which 找到 claude: " + path + " (" + version + ")");
                        return path;
                    }
                }
            }
            boolean finished = process.waitFor(5, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
            }
        } catch (Exception e) {
            LOG.debug("[ClaudeCliDetector] where/which 查找失败: " + e.getMessage());
        }
        return null;
    }

    /**
     * Windows 下从 where 命令多行输出中选择 .cmd 文件。
     * npm 全局安装的 claude 会生成 Unix shell 脚本，直接调用会报 CreateProcess error=193。
     */
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
            String expanded = expandEnvVars(template);
            pathsToCheck.add(expanded);
        }

        // npm 全局安装路径
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
            File f = new File(path);
            if (!f.exists()) {
                continue;
            }
            if (!PlatformUtils.isWindows() && !f.canExecute()) {
                continue;
            }
            String version = verifyCliPath(path);
            if (version != null) {
                cachedCliVersion = version;
                LOG.info("[ClaudeCliDetector] 在已知路径找到 claude: " + path + " (" + version + ")");
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
                LOG.info("[ClaudeCliDetector] 在 PATH 中找到 claude: " + absPath + " (" + version + ")");
                return absPath;
            }
        }
        return null;
    }

    private String detectViaFallback(List<String> triedPaths) {
        triedPaths.add("claude (direct call)");
        String version = verifyCliPath("claude");
        if (version != null) {
            cachedCliVersion = version;
            LOG.info("[ClaudeCliDetector] 直接调用 claude 成功 (" + version + ")");
            return "claude";
        }
        return null;
    }

    /**
     * 验证指定路径是否为有效的 claude CLI。
     *
     * @return 版本字符串，验证失败返回 null
     */
    public String verifyCliPath(String path) {
        try {
            ProcessBuilder pb = new ProcessBuilder(path, "--version");
            Process process = pb.start();
            String version = null;
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
            LOG.debug("[ClaudeCliDetector] 验证失败 [" + path + "]: " + e.getMessage());
        }
        return null;
    }

    /**
     * 手动设置 CLI 路径。
     */
    public void setCliPath(String path) {
        synchronized (this) {
            this.cachedCliPath = path;
            this.detectionAttempted = (path != null);
            if (path != null) {
                this.cachedCliVersion = verifyCliPath(path);
            } else {
                this.cachedCliVersion = null;
            }
        }
    }

    /**
     * 获取缓存版本。
     */
    public String getCachedVersion() {
        return cachedCliVersion;
    }

    /**
     * 清除缓存。
     */
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

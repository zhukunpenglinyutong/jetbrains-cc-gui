package com.github.claudecodegui.bridge;

import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.ShellExecutor;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.TimeUnit;

/**
 * Node.js detector.
 * Responsible for locating and verifying Node.js executable across various platforms.
 * Implemented as a singleton to share cache across ClaudeSDKBridge and CodexSDKBridge.
 */
public class NodeDetector {

    private static final Logger LOG = Logger.getInstance(NodeDetector.class);
    // Common Node.js installation paths on Windows
    private static final String[] WINDOWS_NODE_PATHS = {
            // Official installer defaults
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Program Files (x86)\\nodejs\\node.exe",
            // Chocolatey
            "C:\\ProgramData\\chocolatey\\bin\\node.exe",
            // Scoop
            "%USERPROFILE%\\scoop\\apps\\nodejs\\current\\node.exe",
            "%USERPROFILE%\\scoop\\apps\\nodejs-lts\\current\\node.exe",
            // nvm-windows
            "%APPDATA%\\nvm\\current\\node.exe",
            // fnm
            "%USERPROFILE%\\.fnm\\node-versions\\default\\installation\\node.exe",
            // volta
            "%USERPROFILE%\\.volta\\bin\\node.exe",
            // Custom user installation
            "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"
    };

    // ============================================================================
    // Singleton Implementation
    // ============================================================================

    private static volatile NodeDetector instance;
    private static final Object lock = new Object();

    /** Private constructor to enforce singleton pattern. */
    private NodeDetector() {
    }

    /**
     * Get the singleton instance of NodeDetector.
     * This ensures that ClaudeSDKBridge and CodexSDKBridge share the same cache.
     *
     * @return shared NodeDetector instance
     */
    public static NodeDetector getInstance() {
        if (instance == null) {
            synchronized (lock) {
                if (instance == null) {
                    instance = new NodeDetector();
                }
            }
        }
        return instance;
    }

    /**
     * Reset the singleton instance.
     * This method is primarily intended for testing purposes to reset
     * the shared state between test cases.
     *
     * <p>WARNING: Calling this in production code will clear the cached
     * Node.js path and may cause performance degradation.</p>
     */
    public static void resetInstance() {
        synchronized (lock) {
            instance = null;
        }
    }

    // ============================================================================
    // Instance Fields
    // ============================================================================

    // Cache fields - volatile to ensure visibility across threads in this singleton
    private volatile String cachedNodeExecutable = null;
    private volatile NodeDetectionResult cachedDetectionResult = null;
    private volatile CompletableFuture<NodeDetectionResult> inFlightDetection = null;
    // Lock for cache operations to ensure thread safety
    private final Object cacheLock = new Object();
    // Executor for in-flight detection. Defaults to ForkJoinPool.commonPool().
    private volatile Executor detectionExecutor = ForkJoinPool.commonPool();

    /**
     * Finds Node.js executable path.
     */
    public String findNodeExecutable() {
        long startTime = System.currentTimeMillis();
        if (this.cachedNodeExecutable != null) {
            return this.cachedNodeExecutable;
        }

        try {
            CompletableFuture<NodeDetectionResult> detectionFuture;
            synchronized (this.cacheLock) {
                if (this.cachedNodeExecutable != null) {
                    return this.cachedNodeExecutable;
                }
                if (this.inFlightDetection == null) {
                    this.inFlightDetection = CompletableFuture.supplyAsync(
                        this::detectNodeWithDetails, this.detectionExecutor
                    );
                }
                detectionFuture = this.inFlightDetection;
            }

            NodeDetectionResult result;
            try {
                result = detectionFuture.join();
            } catch (CancellationException e) {
                LOG.info("[NodeDetector] In-flight detection was cancelled, retrying once.");
                result = this.detectNodeWithDetails();
            } catch (CompletionException e) {
                LOG.warn("[NodeDetector] Node detection failed: " + e.getMessage(), e);
                result = NodeDetectionResult.failure("Node.js 检测异常: " + e.getMessage());
            }

            synchronized (this.cacheLock) {
                if (this.inFlightDetection == detectionFuture) {
                    this.inFlightDetection = null;
                }
                if (this.cachedNodeExecutable != null) {
                    return this.cachedNodeExecutable;
                }
                if (result != null && result.isFound()) {
                    this.cachedDetectionResult = result;
                    this.cachedNodeExecutable = result.getNodePath();
                    return this.cachedNodeExecutable;
                }
                LOG.warn("⚠️ 无法自动检测 Node.js 路径，使用默认值 'node'");
                if (result != null) {
                    LOG.warn(result.getUserFriendlyMessage());
                    this.cachedDetectionResult = result;
                }
                this.cachedNodeExecutable = "node";
                return this.cachedNodeExecutable;
            }
        } finally {
            long elapsed = System.currentTimeMillis() - startTime;
            LOG.info("[NodeDetector] findNodeExecutable completed in " + elapsed +
                     "ms on thread " + Thread.currentThread().getName());
        }
    }

    /**
     * Detects Node.js and returns a detailed result.
     *
     * @return NodeDetectionResult containing detection details
     */
    public NodeDetectionResult detectNodeWithDetails() {
        long startTime = System.currentTimeMillis();
        try {
            List<String> triedPaths = new ArrayList<>();
            LOG.info("正在查找 Node.js...");
            LOG.info("  操作系统: " + System.getProperty("os.name"));
            LOG.info("  平台类型: " + (PlatformUtils.isWindows() ? "Windows" :
                                               (PlatformUtils.isMac() ? "macOS" : "Linux/Unix")));

            // 1. Try locating via system commands (where/which)
            NodeDetectionResult cmdResult = detectNodeViaSystemCommand(triedPaths);
            if (cmdResult != null && cmdResult.isFound()) {
                return cmdResult;
            }

            // 2. Try known installation paths
            NodeDetectionResult knownPathResult = detectNodeViaKnownPaths(triedPaths);
            if (knownPathResult != null && knownPathResult.isFound()) {
                return knownPathResult;
            }

            // 3. Try PATH environment variable
            NodeDetectionResult pathResult = detectNodeViaPath(triedPaths);
            if (pathResult != null && pathResult.isFound()) {
                return pathResult;
            }

            // 4. Final fallback: try invoking "node" directly
            NodeDetectionResult fallbackResult = detectNodeViaFallback(triedPaths);
            if (fallbackResult != null && fallbackResult.isFound()) {
                return fallbackResult;
            }

            return NodeDetectionResult.failure("在所有已知路径中均未找到 Node.js", triedPaths);
        } finally {
            long elapsed = System.currentTimeMillis() - startTime;
            LOG.info("[NodeDetector] detectNodeWithDetails completed in " + elapsed +
                     "ms on thread " + Thread.currentThread().getName());
        }
    }

    /**
     * Detects Node.js via system commands (where/which).
     */
    private NodeDetectionResult detectNodeViaSystemCommand(List<String> triedPaths) {
        if (PlatformUtils.isWindows()) {
            return detectNodeViaWindowsWhere(triedPaths);
        } else {
            // macOS/Linux: try zsh first (macOS default), then bash
            NodeDetectionResult result = detectNodeViaShell("/bin/zsh", "zsh", triedPaths);
            if (result != null && result.isFound()) {
                return result;
            }
            return detectNodeViaShell("/bin/bash", "bash", triedPaths);
        }
    }

    /**
     * Windows: detects Node.js using "where" command.
     */
    private NodeDetectionResult detectNodeViaWindowsWhere(List<String> triedPaths) {
        try {
            ProcessBuilder pb = new ProcessBuilder("where", "node");
            String methodDesc = "Windows where 命令";

            LOG.info("  尝试方法: " + methodDesc);
            Process process = pb.start();

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String path = reader.readLine();
                if (path != null && !path.isEmpty()) {
                    path = path.trim();
                    triedPaths.add(path);

                    String version = verifyNodePath(path);
                    if (version != null) {
                        LOG.info("✓ 通过 " + methodDesc + " 找到 Node.js: " + path + " (" + version + ")");
                        return NodeDetectionResult.success(
                                path, version,
                                NodeDetectionResult.DetectionMethod.WHERE_COMMAND,
                                triedPaths
                        );
                    }
                }
            }

            boolean finished = process.waitFor(5, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
            }
        } catch (Exception e) {
            LOG.debug("  Windows where 命令查找失败: " + e.getMessage());
        }
        return null;
    }

    /**
     * Unix/macOS: detects Node.js through a specified shell.
     *
     * @param shellPath  path to shell executable (e.g. /bin/zsh or /bin/bash)
     * @param shellName  shell name for logging
     * @param triedPaths list of paths already attempted
     */
    private NodeDetectionResult detectNodeViaShell(String shellPath, String shellName, List<String> triedPaths) {
        // Check if shell exists
        if (!new File(shellPath).exists()) {
            LOG.debug("  跳过 " + shellName + "（不存在）");
            return null;
        }

        String methodDesc = shellName + " which 命令（登录+交互式 shell）";
        LOG.info("  尝试方法: " + methodDesc);

        // Use -l (login shell) and -i (interactive) to ensure user configuration is loaded.
        // This picks up paths configured by version managers like nvm and fnm.
        // fnm requires an interactive shell to run eval "$(fnm env)" initialization in .zshrc.
        List<String> command = new ArrayList<>();
        command.add(shellPath);
        command.add("-l"); // Login shell
        command.add("-i"); // Interactive shell
        command.add("-c");
        command.add("which node");

        ShellExecutor.ExecutionResult result = ShellExecutor.execute(
                command,
                ShellExecutor.createNodePathFilter(),
                "  " + shellName,
                ShellExecutor.DEFAULT_TIMEOUT_SECONDS,
                true
        );

        if (result.isSuccess() && result.getOutput() != null) {
            String nodePath = result.getOutput();
            triedPaths.add(nodePath);

            String version = verifyNodePath(nodePath);
            if (version != null) {
                LOG.info("✓ 通过 " + methodDesc + " 找到 Node.js: " + nodePath + " (" + version + ")");
                return NodeDetectionResult.success(
                        nodePath, version,
                        NodeDetectionResult.DetectionMethod.WHICH_COMMAND,
                        triedPaths
                );
            }
        }

        return null;
    }

    /**
     * Detects Node.js by checking known installation paths.
     */
    private NodeDetectionResult detectNodeViaKnownPaths(List<String> triedPaths) {
        String userHome = PlatformUtils.getHomeDirectory();
        List<String> pathsToCheck = new ArrayList<>();

        if (PlatformUtils.isWindows()) {
            // Windows paths: expand environment variables and add
            LOG.info("  正在检查 Windows 常见安装路径...");
            for (String templatePath : WINDOWS_NODE_PATHS) {
                String expandedPath = expandWindowsEnvVars(templatePath);
                pathsToCheck.add(expandedPath);
            }

            // Dynamically discover nvm-windows versions
            String nvmHome = PlatformUtils.getEnvIgnoreCase("NVM_HOME");
            if (nvmHome == null) {
                nvmHome = System.getenv("APPDATA") + "\\nvm";
            }
            File nvmDir = new File(nvmHome);
            if (nvmDir.exists() && nvmDir.isDirectory()) {
                File[] versionDirs = nvmDir.listFiles(File::isDirectory);
                if (versionDirs != null) {
                    java.util.Arrays.sort(versionDirs, (a, b) -> b.getName().compareTo(a.getName()));
                    for (File versionDir : versionDirs) {
                        if (versionDir.getName().startsWith("v")) {
                            String nodePath = versionDir.getAbsolutePath() + "\\node.exe";
                            pathsToCheck.add(nodePath);
                            LOG.info("  发现 nvm-windows Node.js: " + nodePath);
                        }
                    }
                }
            }
        } else {
            // macOS/Linux paths
            LOG.info("  正在检查 Unix/macOS 常见安装路径...");

            // Dynamically discover NVM-managed versions
            File nvmDir = new File(userHome + "/.nvm/versions/node");
            if (nvmDir.exists() && nvmDir.isDirectory()) {
                File[] versionDirs = nvmDir.listFiles();
                if (versionDirs != null) {
                    java.util.Arrays.sort(versionDirs, (a, b) -> b.getName().compareTo(a.getName()));
                    for (File versionDir : versionDirs) {
                        if (versionDir.isDirectory()) {
                            String nodePath = versionDir.getAbsolutePath() + "/bin/node";
                            pathsToCheck.add(nodePath);
                            LOG.info("  发现 NVM Node.js: " + nodePath);
                        }
                    }
                }
            }

            // Dynamically discover Homebrew version-specific Node.js (node@18, node@20, node@22, etc.)
            // Apple Silicon: /opt/homebrew/opt/node@XX/bin/node
            // Intel Mac: /usr/local/opt/node@XX/bin/node
            String[] homebrewOptDirs = {"/opt/homebrew/opt", "/usr/local/opt"};
            for (String optDir : homebrewOptDirs) {
                File optFile = new File(optDir);
                if (optFile.exists() && optFile.isDirectory()) {
                    File[] nodeDirs = optFile.listFiles((dir, name) ->
                                                                name.equals("node") || name.startsWith("node@"));
                    if (nodeDirs != null) {
                        // Sort by version number descending, prefer newer versions
                        java.util.Arrays.sort(nodeDirs, (a, b) -> {
                            // node@22 > node@20 > node@18 > node
                            String aName = a.getName();
                            String bName = b.getName();
                            int aVersion = aName.equals("node") ? 0 :
                                                   parseNodeVersion(aName.substring(5));
                            int bVersion = bName.equals("node") ? 0 :
                                                   parseNodeVersion(bName.substring(5));
                            return Integer.compare(bVersion, aVersion);
                        });
                        for (File nodeDir : nodeDirs) {
                            String nodePath = nodeDir.getAbsolutePath() + "/bin/node";
                            pathsToCheck.add(nodePath);
                            LOG.info("  发现 Homebrew Node.js: " + nodePath);
                        }
                    }
                }
            }

            // Dynamically discover nvmd-managed Node.js
            // nvmd (Node Version Manager Desktop): ~/.nvmd/bin/node
            File nvmdBin = new File(userHome + "/.nvmd/bin/node");
            if (nvmdBin.exists()) {
                pathsToCheck.add(nvmdBin.getAbsolutePath());
                LOG.info("  发现 nvmd Node.js: " + nvmdBin.getAbsolutePath());
            }

            // Add common Unix/macOS paths
            pathsToCheck.add("/usr/local/bin/node");           // Homebrew (macOS Intel)
            pathsToCheck.add("/opt/homebrew/bin/node");        // Homebrew (Apple Silicon)
            pathsToCheck.add("/usr/bin/node");                 // Linux system
            pathsToCheck.add(userHome + "/.volta/bin/node");   // Volta
            pathsToCheck.add(userHome + "/.fnm/aliases/default/bin/node"); // fnm
            pathsToCheck.add(userHome + "/.nvmd/bin/node");    // nvmd (Node Version Manager Desktop)
        }

        // Check each path
        for (String path : pathsToCheck) {
            triedPaths.add(path);

            File nodeFile = new File(path);
            if (!nodeFile.exists()) {
                LOG.debug("  跳过不存在: " + path);
                continue;
            }

            // Skip canExecute() check on Windows due to inconsistent behavior
            if (!PlatformUtils.isWindows() && !nodeFile.canExecute()) {
                LOG.debug("  跳过无执行权限: " + path);
                continue;
            }

            String version = verifyNodePath(path);
            if (version != null) {
                LOG.info("✓ 在已知路径找到 Node.js: " + path + " (" + version + ")");
                return NodeDetectionResult.success(path, version,
                        NodeDetectionResult.DetectionMethod.KNOWN_PATH, triedPaths);
            }
        }

        return null;
    }

    /**
     * Detects Node.js by scanning PATH environment variable.
     */
    private NodeDetectionResult detectNodeViaPath(List<String> triedPaths) {
        LOG.info("  正在检查 PATH 环境变量...");

        // Get PATH using platform-compatible approach
        String pathEnv = PlatformUtils.isWindows() ?
                                 PlatformUtils.getEnvIgnoreCase("PATH") :
                                 System.getenv("PATH");

        if (pathEnv == null || pathEnv.isEmpty()) {
            LOG.debug("  PATH 环境变量为空");
            return null;
        }

        String[] paths = pathEnv.split(File.pathSeparator);
        String nodeFileName = PlatformUtils.isWindows() ? "node.exe" : "node";

        for (String dir : paths) {
            if (dir == null || dir.isEmpty()) continue;

            File nodeFile = new File(dir, nodeFileName);
            String nodePath = nodeFile.getAbsolutePath();
            triedPaths.add(nodePath);

            if (!nodeFile.exists()) continue;

            String version = verifyNodePath(nodePath);
            if (version != null) {
                LOG.info("✓ 在 PATH 中找到 Node.js: " + nodePath + " (" + version + ")");
                return NodeDetectionResult.success(nodePath, version,
                        NodeDetectionResult.DetectionMethod.PATH_VARIABLE, triedPaths);
            }
        }

        return null;
    }

    /**
     * Fallback detection: tries invoking "node" directly.
     */
    private NodeDetectionResult detectNodeViaFallback(List<String> triedPaths) {
        LOG.info("  尝试直接调用 'node'（回退方案）...");
        triedPaths.add("node (direct call)");

        try {
            ProcessBuilder pb = new ProcessBuilder("node", "--version");
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

            int exitCode = process.exitValue();
            if (exitCode == 0 && version != null) {
                version = version.trim();
                LOG.info("✓ 直接调用 node 成功 (" + version + ")");
                return NodeDetectionResult.success("node", version,
                        NodeDetectionResult.DetectionMethod.FALLBACK, triedPaths);
            }
        } catch (Exception e) {
            LOG.debug("  直接调用 'node' 失败: " + e.getMessage());
        }

        return null;
    }

    /**
     * Verifies whether a Node.js path is usable.
     *
     * @param path Node.js executable path
     * @return version string if usable, otherwise null
     */
    public String verifyNodePath(String path) {
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
     * For example: %USERPROFILE%\\.nvm -> C:\Users\xxx\.nvm
     */
    private String expandWindowsEnvVars(String path) {
        if (path == null) return null;

        String result = path;

        // Expand common environment variables
        result = result.replace("%USERPROFILE%", PlatformUtils.getHomeDirectory());
        result = result.replace("%APPDATA%", System.getenv("APPDATA") != null ?
                                                     System.getenv("APPDATA") : "");
        result = result.replace("%LOCALAPPDATA%", System.getenv("LOCALAPPDATA") != null ?
                                                          System.getenv("LOCALAPPDATA") : "");
        result = result.replace("%ProgramFiles%", System.getenv("ProgramFiles") != null ?
                                                          System.getenv("ProgramFiles") : "C:\\Program Files");
        result = result.replace("%ProgramFiles(x86)%", System.getenv("ProgramFiles(x86)") != null ?
                                                               System.getenv("ProgramFiles(x86)") : "C:\\Program Files (x86)");

        return result;
    }

    /**
     * Parses a Node.js version number string.
     * For example: "20" -> 20, "18" -> 18
     */
    private int parseNodeVersion(String version) {
        if (version == null || version.isEmpty()) {
            return 0;
        }
        try {
            // Handle possible dotted versions like "20.1" -> extract major version 20
            int dotIndex = version.indexOf('.');
            if (dotIndex > 0) {
                version = version.substring(0, dotIndex);
            }
            return Integer.parseInt(version);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /**
     * Manually sets the Node.js executable path.
     * Also clears the cached detection result so it will be re-verified on next use.
     */
    public void setNodeExecutable(String path) {
        synchronized (this.cacheLock) {
            this.clearInFlightLocked();
            this.cachedNodeExecutable = path;
            // Clear detection result cache to keep cache state consistent.
            // The new path will be re-verified and cached on next call to verifyAndCacheNodePath.
            this.cachedDetectionResult = null;
        }
    }

    /**
     * Get current Node.js executable path.
     */
    public String getNodeExecutable() {
        if (this.cachedNodeExecutable == null) {
            return findNodeExecutable();
        }
        return this.cachedNodeExecutable;
    }

    /**
     * Clears the cached Node.js path and detection result.
     * Since NodeDetector is a singleton, this affects all callers.
     */
    public void clearCache() {
        synchronized (this.cacheLock) {
            this.clearInFlightLocked();
            this.cachedNodeExecutable = null;
            this.cachedDetectionResult = null;
        }
    }

    /**
     * Clears the in-flight detection request.
     */
    public void clearInFlight() {
        synchronized (this.cacheLock) {
            this.clearInFlightLocked();
        }
    }

    /**
     * Sets the executor used for in-flight Node detection tasks.
     * Call this early (e.g. during plugin init) to replace the default ForkJoinPool.
     */
    public void setDetectionExecutor(Executor executor) {
        this.detectionExecutor = executor;
    }

    /**
     * Gets cached detection result.
     * Synchronized to ensure consistent read with other cache operations.
     */
    public NodeDetectionResult getCachedDetectionResult() {
        synchronized (this.cacheLock) {
            return this.cachedDetectionResult;
        }
    }

    /**
     * Gets the cached Node.js executable path from the detection result, falling back to the cached executable.
     * Synchronized to ensure atomic read of both cache fields.
     *
     * @return cached Node.js path, or null if not yet detected
     */
    public String getCachedNodePath() {
        synchronized (this.cacheLock) {
            if (this.cachedDetectionResult != null && this.cachedDetectionResult.getNodePath() != null) {
                return this.cachedDetectionResult.getNodePath();
            }
            return this.cachedNodeExecutable;
        }
    }

    /**
     * Gets the cached Node.js version string.
     * Synchronized to ensure consistent read with other cache operations.
     *
     * @return cached version string (e.g. "v20.10.0"), or null if not yet detected
     */
    public String getCachedNodeVersion() {
        synchronized (this.cacheLock) {
            return this.cachedDetectionResult != null ? this.cachedDetectionResult.getNodeVersion() : null;
        }
    }

    /**
     * Verify and cache a Node.js path.
     * Returns the detection result and updates the shared cache.
     *
     * @param path Node.js executable path to verify
     * @return NodeDetectionResult with verification details
     */
    public NodeDetectionResult verifyAndCacheNodePath(String path) {
        if (path == null || path.isEmpty()) {
            clearCache();
            return NodeDetectionResult.failure("未指定 Node.js 路径");
        }
        String version = verifyNodePath(path);
        NodeDetectionResult result;
        if (version != null) {
            result = NodeDetectionResult.success(path, version, NodeDetectionResult.DetectionMethod.KNOWN_PATH);
        } else {
            result = NodeDetectionResult.failure("无法验证指定的 Node.js 路径: " + path);
        }
        cacheDetection(result);
        return result;
    }

    /**
     * Cache a detection result.
     */
    private void cacheDetection(NodeDetectionResult result) {
        synchronized (this.cacheLock) {
            this.clearInFlightLocked();
            this.cachedDetectionResult = result;
            if (result != null && result.isFound() && result.getNodePath() != null) {
                this.cachedNodeExecutable = result.getNodePath();
            }
        }
    }

    /**
     * Clears the in-flight detection future under cache lock.
     */
    private void clearInFlightLocked() {
        if (this.inFlightDetection != null) {
            // CompletableFuture.cancel() ignores the mayInterruptIfRunning parameter,
            // but we cancel to signal CancellationException to any waiting callers.
            this.inFlightDetection.cancel(false);
            this.inFlightDetection = null;
        }
    }

    /**
     * Minimum required Node.js major version.
     */
    public static final int MIN_NODE_MAJOR_VERSION = 18;

    /**
     * Parses major version number from a version string.
     *
     * @param version version string, e.g. "v20.10.0" or "20.10.0"
     * @return major version number, or 0 if parsing fails
     */
    public static int parseMajorVersion(String version) {
        if (version == null || version.isEmpty()) {
            return 0;
        }
        try {
            String versionStr = version.startsWith("v") ? version.substring(1) : version;
            int dotIndex = versionStr.indexOf('.');
            if (dotIndex > 0) {
                return Integer.parseInt(versionStr.substring(0, dotIndex));
            }
            return Integer.parseInt(versionStr);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /**
     * Checks whether Node.js version meets the minimum requirement.
     *
     * @param version version string
     * @return true if version is >= 18, false otherwise
     */
    public static boolean isVersionSupported(String version) {
        int major = parseMajorVersion(version);
        return major >= MIN_NODE_MAJOR_VERSION;
    }
}

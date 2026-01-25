package com.github.claudecodegui.bridge;

import com.intellij.openapi.diagnostic.Logger;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.ShellExecutor;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Node.js 检测器
 * 负责在各种平台上查找和验证 Node.js 可执行文件
 */
public class NodeDetector {

    private static final Logger LOG = Logger.getInstance(NodeDetector.class);
    // Windows 常见 Node.js 安装路径
    private static final String[] WINDOWS_NODE_PATHS = {
        // 官方安装程序默认路径
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
        // 用户自定义安装
        "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"
    };

    private String cachedNodeExecutable = null;
    private NodeDetectionResult cachedDetectionResult = null;

    /**
     * 查找 Node.js 可执行文件路径
     */
    public String findNodeExecutable() {
        if (cachedNodeExecutable != null) {
            return cachedNodeExecutable;
        }

        NodeDetectionResult result = detectNodeWithDetails();
        if (result.isFound()) {
            cachedNodeExecutable = result.getNodePath();
            return cachedNodeExecutable;
        }

        // 如果都找不到，最后回退
        LOG.warn("⚠️ 无法自动检测 Node.js 路径，使用默认值 'node'");
        LOG.warn(result.getUserFriendlyMessage());
        cachedNodeExecutable = "node";
        return cachedNodeExecutable;
    }

    /**
     * 检测 Node.js 并返回详细结果
     * @return NodeDetectionResult 包含检测详情
     */
    public NodeDetectionResult detectNodeWithDetails() {
        List<String> triedPaths = new ArrayList<>();
        LOG.info("正在查找 Node.js...");
        LOG.info("  操作系统: " + System.getProperty("os.name"));
        LOG.info("  平台类型: " + (PlatformUtils.isWindows() ? "Windows" :
            (PlatformUtils.isMac() ? "macOS" : "Linux/Unix")));

        // 1. 尝试使用系统命令查找 (where/which)
        NodeDetectionResult cmdResult = detectNodeViaSystemCommand(triedPaths);
        if (cmdResult != null && cmdResult.isFound()) {
            return cmdResult;
        }

        // 2. 尝试已知安装路径
        NodeDetectionResult knownPathResult = detectNodeViaKnownPaths(triedPaths);
        if (knownPathResult != null && knownPathResult.isFound()) {
            return knownPathResult;
        }

        // 3. 尝试 PATH 环境变量
        NodeDetectionResult pathResult = detectNodeViaPath(triedPaths);
        if (pathResult != null && pathResult.isFound()) {
            return pathResult;
        }

        // 4. 最后回退：直接尝试 "node"
        NodeDetectionResult fallbackResult = detectNodeViaFallback(triedPaths);
        if (fallbackResult != null && fallbackResult.isFound()) {
            return fallbackResult;
        }

        return NodeDetectionResult.failure("在所有已知路径中均未找到 Node.js", triedPaths);
    }

    /**
     * 通过系统命令 (where/which) 检测 Node.js
     */
    private NodeDetectionResult detectNodeViaSystemCommand(List<String> triedPaths) {
        if (PlatformUtils.isWindows()) {
            return detectNodeViaWindowsWhere(triedPaths);
        } else {
            // macOS/Linux: 先尝试 zsh（macOS 默认），再尝试 bash
            NodeDetectionResult result = detectNodeViaShell("/bin/zsh", "zsh", triedPaths);
            if (result != null && result.isFound()) {
                return result;
            }
            return detectNodeViaShell("/bin/bash", "bash", triedPaths);
        }
    }

    /**
     * Windows: 使用 where 命令检测 Node.js
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
     * Unix/macOS: 通过指定 shell 检测 Node.js
     * @param shellPath shell 可执行文件路径（如 /bin/zsh 或 /bin/bash）
     * @param shellName shell 名称（用于日志）
     * @param triedPaths 已尝试的路径列表
     */
    private NodeDetectionResult detectNodeViaShell(String shellPath, String shellName, List<String> triedPaths) {
        // 检查 shell 是否存在
        if (!new File(shellPath).exists()) {
            LOG.debug("  跳过 " + shellName + "（不存在）");
            return null;
        }

        String methodDesc = shellName + " which 命令（登录+交互式 shell）";
        LOG.info("  尝试方法: " + methodDesc);

        // 使用 -l（登录 shell）和 -i（交互式）确保加载用户配置
        // 这样可以获取 nvm、fnm 等版本管理器配置的路径
        // fnm 需要交互式 shell 来执行 .zshrc 中的 eval "$(fnm env)" 初始化
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
     * 通过已知安装路径检测 Node.js
     */
    private NodeDetectionResult detectNodeViaKnownPaths(List<String> triedPaths) {
        String userHome = System.getProperty("user.home");
        List<String> pathsToCheck = new ArrayList<>();

        if (PlatformUtils.isWindows()) {
            // Windows 路径：展开环境变量并添加
            LOG.info("  正在检查 Windows 常见安装路径...");
            for (String templatePath : WINDOWS_NODE_PATHS) {
                String expandedPath = expandWindowsEnvVars(templatePath);
                pathsToCheck.add(expandedPath);
            }

            // 动态查找 nvm-windows 版本
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
            // macOS/Linux 路径
            LOG.info("  正在检查 Unix/macOS 常见安装路径...");

            // 动态查找 NVM 管理的版本
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

            // 动态查找 Homebrew 版本特定的 Node.js (node@18, node@20, node@22 等)
            // Apple Silicon: /opt/homebrew/opt/node@XX/bin/node
            // Intel Mac: /usr/local/opt/node@XX/bin/node
            String[] homebrewOptDirs = {"/opt/homebrew/opt", "/usr/local/opt"};
            for (String optDir : homebrewOptDirs) {
                File optFile = new File(optDir);
                if (optFile.exists() && optFile.isDirectory()) {
                    File[] nodeDirs = optFile.listFiles((dir, name) ->
                        name.equals("node") || name.startsWith("node@"));
                    if (nodeDirs != null) {
                        // 按版本号降序排序，优先使用较新版本
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

            // 动态查找 nvmd 管理的 Node.js
            // nvmd (Node Version Manager Desktop): ~/.nvmd/bin/node
            File nvmdBin = new File(userHome + "/.nvmd/bin/node");
            if (nvmdBin.exists()) {
                pathsToCheck.add(nvmdBin.getAbsolutePath());
                LOG.info("  发现 nvmd Node.js: " + nvmdBin.getAbsolutePath());
            }

            // 添加常见 Unix/macOS 路径
            pathsToCheck.add("/usr/local/bin/node");           // Homebrew (macOS Intel)
            pathsToCheck.add("/opt/homebrew/bin/node");        // Homebrew (Apple Silicon)
            pathsToCheck.add("/usr/bin/node");                 // Linux 系统
            pathsToCheck.add(userHome + "/.volta/bin/node");   // Volta
            pathsToCheck.add(userHome + "/.fnm/aliases/default/bin/node"); // fnm
            pathsToCheck.add(userHome + "/.nvmd/bin/node");    // nvmd (Node Version Manager Desktop)
        }

        // 遍历检查每个路径
        for (String path : pathsToCheck) {
            triedPaths.add(path);

            File nodeFile = new File(path);
            if (!nodeFile.exists()) {
                LOG.debug("  跳过不存在: " + path);
                continue;
            }

            // Windows 不检查 canExecute()，因为行为不一致
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
     * 通过 PATH 环境变量检测 Node.js
     */
    private NodeDetectionResult detectNodeViaPath(List<String> triedPaths) {
        LOG.info("  正在检查 PATH 环境变量...");

        // 使用平台兼容的方式获取 PATH
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
     * 回退检测：直接尝试执行 "node"
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
     * 验证 Node.js 路径是否可用
     * @param path Node.js 路径
     * @return 版本号（如果可用），否则返回 null
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
     * 展开 Windows 环境变量
     * 例如: %USERPROFILE%\\.nvm -> C:\Users\xxx\.nvm
     */
    private String expandWindowsEnvVars(String path) {
        if (path == null) return null;

        String result = path;

        // 展开常见环境变量
        result = result.replace("%USERPROFILE%", System.getProperty("user.home", ""));
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
     * 解析 Node.js 版本号
     * 例如: "20" -> 20, "18" -> 18
     */
    private int parseNodeVersion(String version) {
        if (version == null || version.isEmpty()) {
            return 0;
        }
        try {
            // 处理可能的小数点版本，如 "20.1" -> 取主版本号 20
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
     * 手动设置 Node.js 可执行文件路径.
     * 同时清除缓存的检测结果，以便下次使用时重新验证
     */
    public void setNodeExecutable(String path) {
        this.cachedNodeExecutable = path;
        // 清除检测结果缓存，确保缓存状态一致
        // 新路径会在下次调用 verifyAndCacheNodePath 时重新验证并缓存
        this.cachedDetectionResult = null;
    }

    /**
     * 获取当前使用的 Node.js 路径
     */
    public String getNodeExecutable() {
        if (cachedNodeExecutable == null) {
            return findNodeExecutable();
        }
        return cachedNodeExecutable;
    }

    /**
     * 清除缓存的 Node.js 路径和检测结果
     */
    public void clearCache() {
        this.cachedNodeExecutable = null;
        this.cachedDetectionResult = null;
    }

    /**
     * 获取缓存的检测结果
     */
    public NodeDetectionResult getCachedDetectionResult() {
        return cachedDetectionResult;
    }

    public String getCachedNodePath() {
        if (cachedDetectionResult != null && cachedDetectionResult.getNodePath() != null) {
            return cachedDetectionResult.getNodePath();
        }
        return cachedNodeExecutable;
    }

    public String getCachedNodeVersion() {
        return cachedDetectionResult != null ? cachedDetectionResult.getNodeVersion() : null;
    }

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

    private void cacheDetection(NodeDetectionResult result) {
        this.cachedDetectionResult = result;
        if (result != null && result.isFound() && result.getNodePath() != null) {
            this.cachedNodeExecutable = result.getNodePath();
        }
    }

    /**
     * 最低要求的 Node.js 主版本号.
     */
    public static final int MIN_NODE_MAJOR_VERSION = 18;

    /**
     * 从版本字符串中解析主版本号.
     * @param version 版本字符串，如 "v20.10.0" 或 "20.10.0"
     * @return 主版本号，解析失败返回 0
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
     * 检查 Node.js 版本是否满足最低要求.
     * @param version 版本字符串
     * @return true 如果版本 >= 18，否则 false
     */
    public static boolean isVersionSupported(String version) {
        int major = parseMajorVersion(version);
        return major >= MIN_NODE_MAJOR_VERSION;
    }
}

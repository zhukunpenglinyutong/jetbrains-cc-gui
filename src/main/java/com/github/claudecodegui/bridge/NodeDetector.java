package com.github.claudecodegui.bridge;

import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.util.PlatformUtils;

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
        System.err.println("⚠️ 无法自动检测 Node.js 路径，使用默认值 'node'");
        System.err.println(result.getUserFriendlyMessage());
        cachedNodeExecutable = "node";
        return cachedNodeExecutable;
    }

    /**
     * 检测 Node.js 并返回详细结果
     * @return NodeDetectionResult 包含检测详情
     */
    public NodeDetectionResult detectNodeWithDetails() {
        List<String> triedPaths = new ArrayList<>();
        System.out.println("正在查找 Node.js...");
        System.out.println("  操作系统: " + System.getProperty("os.name"));
        System.out.println("  平台类型: " + (PlatformUtils.isWindows() ? "Windows" :
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
        try {
            ProcessBuilder pb;
            String methodDesc;

            if (PlatformUtils.isWindows()) {
                // Windows: 使用 where 命令
                pb = new ProcessBuilder("where", "node");
                methodDesc = "Windows where 命令";
            } else {
                // macOS/Linux: 使用 bash -l -c 'which node' 获取完整 shell 环境
                pb = new ProcessBuilder("/bin/bash", "-l", "-c", "which node");
                methodDesc = "Unix which 命令";
            }

            System.out.println("  尝试方法: " + methodDesc);
            Process process = pb.start();

            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String path = reader.readLine();
                if (path != null && !path.isEmpty()) {
                    path = path.trim();
                    triedPaths.add(path);

                    // 验证路径可用
                    String version = verifyNodePath(path);
                    if (version != null) {
                        System.out.println("✓ 通过 " + methodDesc + " 找到 Node.js: " + path + " (" + version + ")");
                        return NodeDetectionResult.success(
                            path, version,
                            PlatformUtils.isWindows() ?
                                NodeDetectionResult.DetectionMethod.WHERE_COMMAND :
                                NodeDetectionResult.DetectionMethod.WHICH_COMMAND,
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
            System.out.println("  系统命令查找失败: " + e.getMessage());
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
            System.out.println("  正在检查 Windows 常见安装路径...");
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
                            System.out.println("  发现 nvm-windows Node.js: " + nodePath);
                        }
                    }
                }
            }
        } else {
            // macOS/Linux 路径
            System.out.println("  正在检查 Unix/macOS 常见安装路径...");

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
                            System.out.println("  发现 NVM Node.js: " + nodePath);
                        }
                    }
                }
            }

            // 添加常见 Unix/macOS 路径
            pathsToCheck.add("/usr/local/bin/node");           // Homebrew (macOS Intel)
            pathsToCheck.add("/opt/homebrew/bin/node");        // Homebrew (Apple Silicon)
            pathsToCheck.add("/usr/bin/node");                 // Linux 系统
            pathsToCheck.add(userHome + "/.volta/bin/node");   // Volta
            pathsToCheck.add(userHome + "/.fnm/aliases/default/bin/node"); // fnm
        }

        // 遍历检查每个路径
        for (String path : pathsToCheck) {
            triedPaths.add(path);

            File nodeFile = new File(path);
            if (!nodeFile.exists()) {
                System.out.println("  跳过不存在: " + path);
                continue;
            }

            // Windows 不检查 canExecute()，因为行为不一致
            if (!PlatformUtils.isWindows() && !nodeFile.canExecute()) {
                System.out.println("  跳过无执行权限: " + path);
                continue;
            }

            String version = verifyNodePath(path);
            if (version != null) {
                System.out.println("✓ 在已知路径找到 Node.js: " + path + " (" + version + ")");
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
        System.out.println("  正在检查 PATH 环境变量...");

        // 使用平台兼容的方式获取 PATH
        String pathEnv = PlatformUtils.isWindows() ?
            PlatformUtils.getEnvIgnoreCase("PATH") :
            System.getenv("PATH");

        if (pathEnv == null || pathEnv.isEmpty()) {
            System.out.println("  PATH 环境变量为空");
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
                System.out.println("✓ 在 PATH 中找到 Node.js: " + nodePath + " (" + version + ")");
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
        System.out.println("  尝试直接调用 'node'（回退方案）...");
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
                System.out.println("✓ 直接调用 node 成功 (" + version + ")");
                return NodeDetectionResult.success("node", version,
                    NodeDetectionResult.DetectionMethod.FALLBACK, triedPaths);
            }
        } catch (Exception e) {
            System.out.println("  直接调用 'node' 失败: " + e.getMessage());
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
            System.out.println("    验证失败 [" + path + "]: " + e.getMessage());
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
     * 手动设置 Node.js 可执行文件路径
     */
    public void setNodeExecutable(String path) {
        this.cachedNodeExecutable = path;
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
     * 清除缓存的 Node.js 路径
     */
    public void clearCache() {
        this.cachedNodeExecutable = null;
    }
}

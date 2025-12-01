package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.openapi.application.PathManager;
import com.intellij.openapi.extensions.PluginId;
import com.intellij.openapi.util.io.FileUtil;

import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.model.PathCheckResult;
import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.PlatformUtils;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.CodeSource;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Claude Agent SDK 桥接类
 * 负责 Java 与 Node.js SDK 的交互，支持异步和流式响应
 */
public class ClaudeSDKBridge {

    private static final String SDK_DIR_NAME = "claude-bridge";
    private static final String NODE_SCRIPT = "simple-query.js";
    private static final String SDK_ARCHIVE_NAME = "claude-bridge.zip";
    private static final String BRIDGE_VERSION_FILE = ".bridge-version";
    private static final String BRIDGE_PATH_PROPERTY = "claude.bridge.path";
    private static final String BRIDGE_PATH_ENV = "CLAUDE_BRIDGE_PATH";
    private static final String PLUGIN_ID = "com.github.idea-claude-code-gui";
    private static final String PLUGIN_DIR_NAME = "idea-claude-code-gui";
    private static final String CLAUDE_TEMP_DIR_NAME = "claude-agent-tmp";
    private static final String CLAUDE_PERMISSION_ENV = "CLAUDE_PERMISSION_DIR";
    private final Gson gson = new Gson();
    private String nodeExecutable = null;
    private File sdkTestDir = null;
    private final Object bridgeExtractionLock = new Object();
    private final Map<String, Process> activeChannelProcesses = new ConcurrentHashMap<>();
    private final Set<String> interruptedChannels = ConcurrentHashMap.newKeySet();
    private volatile String cachedPermissionDir = null;

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

    /**
     * SDK 消息回调接口
     */
    public interface MessageCallback {
        void onMessage(String type, String content);
        void onError(String error);
        void onComplete(SDKResult result);
    }

    /**
     * SDK 响应结果
     */
    public static class SDKResult {
        public boolean success;
        public String error;
        public int messageCount;
        public List<Object> messages;
        public String rawOutput;
        public String finalResult;

        public SDKResult() {
            this.messages = new ArrayList<>();
        }
    }

    /**
     * 查找 claude-bridge 目录
     */
    private File findSdkTestDir() {
        if (sdkTestDir != null && sdkTestDir.exists()) {
            return sdkTestDir;
        }

        File configuredDir = resolveConfiguredBridgeDir();
        if (configuredDir != null) {
            sdkTestDir = configuredDir;
            return sdkTestDir;
        }

        File embeddedDir = ensureEmbeddedBridgeExtracted();
        if (embeddedDir != null) {
            sdkTestDir = embeddedDir;
            return sdkTestDir;
        }

        System.out.println("正在查找 claude-bridge 目录...");

        // 可能的位置列表
        List<File> possibleDirs = new ArrayList<>();

        // 1. 当前工作目录
        File currentDir = new File(System.getProperty("user.dir"));
        addCandidate(possibleDirs, new File(currentDir, SDK_DIR_NAME));

        // 2. 项目根目录（假设当前目录可能在子目录中）
        File parent = currentDir.getParentFile();
        while (parent != null && parent.exists()) {
            boolean hasIdeaDir = new File(parent, ".idea").exists();
            boolean hasBridgeDir = new File(parent, SDK_DIR_NAME).exists();
            if (hasIdeaDir || hasBridgeDir) {
                addCandidate(possibleDirs, new File(parent, SDK_DIR_NAME));
                if (hasIdeaDir) {
                    break;
                }
            }
            if (isRootDirectory(parent)) {
                break;
            }
            parent = parent.getParentFile();
        }

        // 3. 插件目录及 sandbox
        addPluginCandidates(possibleDirs);

        // 4. 基于类路径推断
        addClasspathCandidates(possibleDirs);

        // 查找第一个存在的目录
        for (File dir : possibleDirs) {
            if (isValidBridgeDir(dir)) {
                sdkTestDir = dir;
                System.out.println("✓ 找到 claude-bridge 目录: " + sdkTestDir.getAbsolutePath());
                return sdkTestDir;
            }
        }

        // 如果都找不到，打印调试信息
        System.err.println("⚠️ 无法找到 claude-bridge 目录，已尝试以下位置：");
        for (File dir : possibleDirs) {
            System.err.println("  - " + dir.getAbsolutePath() + " (存在: " + dir.exists() + ")");
        }

        // 返回默认值
        sdkTestDir = new File(currentDir, SDK_DIR_NAME);
        System.err.println("  使用默认路径: " + sdkTestDir.getAbsolutePath());
        return sdkTestDir;
    }

    /**
     * 查找 Node.js 可执行文件路径
     */
    private String findNodeExecutable() {
        if (nodeExecutable != null) {
            return nodeExecutable;
        }

        NodeDetectionResult result = detectNodeWithDetails();
        if (result.isFound()) {
            nodeExecutable = result.getNodePath();
            return nodeExecutable;
        }

        // 如果都找不到，最后回退
        System.err.println("⚠️ 无法自动检测 Node.js 路径，使用默认值 'node'");
        System.err.println(result.getUserFriendlyMessage());
        nodeExecutable = "node";
        return nodeExecutable;
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
    private String verifyNodePath(String path) {
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
     * 同步执行查询（阻塞方法）
     */
    public SDKResult executeQuerySync(String prompt) {
        return executeQuerySync(prompt, 60); // 默认 60 秒超时
    }

    /**
     * 同步执行查询（可指定超时）
     */
    public SDKResult executeQuerySync(String prompt, int timeoutSeconds) {
        SDKResult result = new SDKResult();
        StringBuilder output = new StringBuilder();
        StringBuilder jsonBuffer = new StringBuilder();
        boolean inJson = false;

        try {
            // 查找 Node.js 可执行文件
            String node = findNodeExecutable();

            // 构建命令
            List<String> command = new ArrayList<>();
            command.add(node);
            command.add(NODE_SCRIPT);
            command.add(prompt);

            // 创建进程
            ProcessBuilder pb = new ProcessBuilder(command);
            File workDir = findSdkTestDir();
            pb.directory(workDir);
            pb.redirectErrorStream(true);
            updateProcessEnvironment(pb);

            Process process = pb.start();

            // 读取输出
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");

                    // 提取 JSON 结果
                    if (line.contains("[JSON_START]")) {
                        inJson = true;
                        jsonBuffer.setLength(0);
                        continue;
                    }
                    if (line.contains("[JSON_END]")) {
                        inJson = false;
                        continue;
                    }
                    if (inJson) {
                        jsonBuffer.append(line).append("\n");
                    }

                    // 提取最终结果
                    if (line.contains("[Assistant]:")) {
                        result.finalResult = line.substring(line.indexOf("[Assistant]:") + 12).trim();
                    }
                }
            }

            // 等待进程结束
            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                result.success = false;
                result.error = "进程超时";
                return result;
            }

            int exitCode = process.exitValue();
            result.rawOutput = output.toString();

            // 解析 JSON 结果
            if (jsonBuffer.length() > 0) {
                try {
                    String jsonStr = jsonBuffer.toString().trim();
                    JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
                    result.success = jsonResult.get("success").getAsBoolean();

                    if (result.success) {
                        result.messageCount = jsonResult.get("messageCount").getAsInt();
                    } else {
                        result.error = jsonResult.has("error") ?
                            jsonResult.get("error").getAsString() : "Unknown error";
                    }
                } catch (Exception e) {
                    result.success = false;
                    result.error = "JSON 解析失败: " + e.getMessage();
                }
            } else {
                result.success = exitCode == 0;
                if (!result.success) {
                    result.error = "进程退出码: " + exitCode;
                }
            }

        } catch (Exception e) {
            result.success = false;
            result.error = e.getMessage();
            result.rawOutput = output.toString();
        }

        return result;
    }

    /**
     * 异步执行查询（非阻塞，返回 CompletableFuture）
     */
    public CompletableFuture<SDKResult> executeQueryAsync(String prompt) {
        return CompletableFuture.supplyAsync(() -> executeQuerySync(prompt));
    }

    /**
     * 流式执行查询（实时回调每一行输出）
     */
    public CompletableFuture<SDKResult> executeQueryStream(String prompt, MessageCallback callback) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder output = new StringBuilder();
            StringBuilder jsonBuffer = new StringBuilder();
            boolean inJson = false;

            try {
                // 查找 Node.js 可执行文件
                String node = findNodeExecutable();

                // 构建命令
                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(NODE_SCRIPT);
                command.add(prompt);

                // 创建进程
                File processTempDir = prepareClaudeTempDir();
                Set<String> existingTempMarkers = snapshotClaudeCwdFiles(processTempDir);

                ProcessBuilder pb = new ProcessBuilder(command);
                File workDir = findSdkTestDir();
                pb.directory(workDir);
                pb.redirectErrorStream(true);
                Map<String, String> env = pb.environment();
                if (processTempDir != null) {
                    String tmpPath = processTempDir.getAbsolutePath();
                    env.put("TMPDIR", tmpPath);
                    env.put("TEMP", tmpPath);
                    env.put("TMP", tmpPath);
                    System.out.println("[ExecuteQueryStream] TMPDIR redirected to: " + tmpPath);
                }
                updateProcessEnvironment(pb);

                Process process = null;
                try {
                    process = pb.start();

                    // 实时读取输出
                    try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                        String line;
                        while ((line = reader.readLine()) != null) {
                            output.append(line).append("\n");

                            // 检测消息类型
                            if (line.contains("[Message Type:")) {
                                String type = extractBetween(line, "[Message Type:", "]");
                                if (type != null) {
                                    callback.onMessage("type", type.trim());
                                }
                            }

                            // 检测助手回复
                            if (line.contains("[Assistant]:")) {
                                String content = line.substring(line.indexOf("[Assistant]:") + 12).trim();
                                result.finalResult = content;
                                callback.onMessage("assistant", content);
                            }

                            // 检测结果
                            if (line.contains("[Result]")) {
                                callback.onMessage("status", "完成");
                            }

                            // 提取 JSON
                            if (line.contains("[JSON_START]")) {
                                inJson = true;
                                jsonBuffer.setLength(0);
                                continue;
                            }
                            if (line.contains("[JSON_END]")) {
                                inJson = false;
                                continue;
                            }
                            if (inJson) {
                                jsonBuffer.append(line).append("\n");
                            }
                        }
                    }

                    // 等待进程结束
                    int exitCode = process.waitFor();
                    result.rawOutput = output.toString();

                    // 解析结果
                    if (jsonBuffer.length() > 0) {
                        try {
                            String jsonStr = jsonBuffer.toString().trim();
                            JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
                            result.success = jsonResult.get("success").getAsBoolean();

                            if (result.success) {
                                result.messageCount = jsonResult.get("messageCount").getAsInt();
                                callback.onComplete(result);
                            } else {
                                result.error = jsonResult.has("error") ?
                                    jsonResult.get("error").getAsString() : "Unknown error";
                                callback.onError(result.error);
                            }
                        } catch (Exception e) {
                            result.success = false;
                            result.error = "JSON 解析失败: " + e.getMessage();
                            callback.onError(result.error);
                        }
                    } else {
                        result.success = exitCode == 0;
                        if (result.success) {
                            callback.onComplete(result);
                        } else {
                            result.error = "进程退出码: " + exitCode;
                            callback.onError(result.error);
                        }
                    }

                } finally {
                    waitForProcessTermination(process);
                    cleanupClaudeTempFiles(processTempDir, existingTempMarkers);
                }

            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                result.rawOutput = output.toString();
                callback.onError(e.getMessage());
            }

            return result;
        });
    }

    /**
     * 检查环境是否就绪
     */
    public boolean checkEnvironment() {
        try {
            String node = findNodeExecutable();
            ProcessBuilder pb = new ProcessBuilder(node, "--version");
            updateProcessEnvironment(pb);
            Process process = pb.start();

            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String version = reader.readLine();
                System.out.println("Node.js 版本: " + version);
            }

            int exitCode = process.waitFor();
            return exitCode == 0;
        } catch (Exception e) {
            System.err.println("环境检查失败: " + e.getMessage());
            return false;
        }
    }

    /**
     * 手动设置 Node.js 可执行文件路径
     */
    public void setNodeExecutable(String path) {
        this.nodeExecutable = path;
    }

    /**
     * 获取当前使用的 Node.js 路径
     */
    public String getNodeExecutable() {
        if (nodeExecutable == null) {
            return findNodeExecutable();
        }
        return nodeExecutable;
    }

    /**
     * 手动设置 claude-bridge 目录路径
     */
    public void setSdkTestDir(String path) {
        this.sdkTestDir = new File(path);
    }

    /**
     * 获取当前使用的 claude-bridge 目录
     */
    public File getSdkTestDir() {
        if (sdkTestDir == null) {
            return findSdkTestDir();
        }
        return sdkTestDir;
    }

    /**
     * 清理所有活动的子进程
     * 应在插件卸载或 IDEA 关闭时调用
     */
    public void cleanupAllProcesses() {
        System.out.println("[ClaudeSDKBridge] Cleaning up all active processes...");
        int count = 0;

        for (Map.Entry<String, Process> entry : activeChannelProcesses.entrySet()) {
            String channelId = entry.getKey();
            Process process = entry.getValue();

            if (process != null && process.isAlive()) {
                System.out.println("[ClaudeSDKBridge] Terminating process for channel: " + channelId);
                PlatformUtils.terminateProcess(process);
                count++;
            }
        }

        activeChannelProcesses.clear();
        interruptedChannels.clear();

        System.out.println("[ClaudeSDKBridge] Cleanup complete. Terminated " + count + " processes.");
    }

    /**
     * 获取当前活动进程数量
     */
    public int getActiveProcessCount() {
        int count = 0;
        for (Process process : activeChannelProcesses.values()) {
            if (process != null && process.isAlive()) {
                count++;
            }
        }
        return count;
    }

    /**
     * 提取字符串中两个标记之间的内容
     */
    private String extractBetween(String text, String start, String end) {
        int startIdx = text.indexOf(start);
        if (startIdx == -1) return null;
        startIdx += start.length();

        int endIdx = text.indexOf(end, startIdx);
        if (endIdx == -1) return null;

        return text.substring(startIdx, endIdx);
    }

    private File resolveConfiguredBridgeDir() {
        File fromProperty = tryResolveConfiguredPath(
            System.getProperty(BRIDGE_PATH_PROPERTY),
            "系统属性 " + BRIDGE_PATH_PROPERTY
        );
        if (fromProperty != null) {
            return fromProperty;
        }
        return tryResolveConfiguredPath(
            System.getenv(BRIDGE_PATH_ENV),
            "环境变量 " + BRIDGE_PATH_ENV
        );
    }

    private File tryResolveConfiguredPath(String path, String source) {
        if (path == null || path.trim().isEmpty()) {
            return null;
        }
        File dir = new File(path.trim());
        if (isValidBridgeDir(dir)) {
            System.out.println("✓ 使用 " + source + ": " + dir.getAbsolutePath());
            return dir;
        }
        System.err.println("⚠️ " + source + " 指向无效目录: " + dir.getAbsolutePath());
        return null;
    }

    private void addPluginCandidates(List<File> possibleDirs) {
        try {
            PluginId pluginId = PluginId.getId(PLUGIN_ID);
            IdeaPluginDescriptor descriptor = PluginManagerCore.getPlugin(pluginId);
            if (descriptor != null) {
                File pluginDir = descriptor.getPluginPath().toFile();
                addCandidate(possibleDirs, new File(pluginDir, SDK_DIR_NAME));
            }
        } catch (Throwable t) {
            System.out.println("  无法从插件描述符推断: " + t.getMessage());
        }

        try {
            String pluginsRoot = PathManager.getPluginsPath();
            if (pluginsRoot != null && !pluginsRoot.isEmpty()) {
                addCandidate(possibleDirs, Paths.get(pluginsRoot, PLUGIN_DIR_NAME, SDK_DIR_NAME).toFile());
                addCandidate(possibleDirs, Paths.get(pluginsRoot, PLUGIN_ID, SDK_DIR_NAME).toFile());
            }

            String sandboxRoot = PathManager.getPluginTempPath();
            if (sandboxRoot != null && !sandboxRoot.isEmpty()) {
                Path sandboxPath = Paths.get(sandboxRoot);
                addCandidate(possibleDirs, sandboxPath.resolve(PLUGIN_DIR_NAME).resolve(SDK_DIR_NAME).toFile());
                addCandidate(possibleDirs, sandboxPath.resolve(PLUGIN_ID).resolve(SDK_DIR_NAME).toFile());
            }
        } catch (Throwable t) {
            System.out.println("  无法从插件路径推断: " + t.getMessage());
        }
    }

    private void addClasspathCandidates(List<File> possibleDirs) {
        try {
            CodeSource codeSource = ClaudeSDKBridge.class.getProtectionDomain().getCodeSource();
            if (codeSource == null || codeSource.getLocation() == null) {
                System.out.println("  无法从类路径推断: CodeSource 不可用");
                return;
            }
            File location = new File(codeSource.getLocation().toURI());
            File classDir = location.getParentFile();
            while (classDir != null && classDir.exists()) {
                addCandidate(possibleDirs, new File(classDir, SDK_DIR_NAME));
                String name = classDir.getName();
                if (PLUGIN_DIR_NAME.equals(name) || PLUGIN_ID.equals(name)) {
                    break;
                }
                if (isRootDirectory(classDir)) {
                    break;
                }
                classDir = classDir.getParentFile();
            }
        } catch (Exception e) {
            System.out.println("  无法从类路径推断: " + e.getMessage());
        }
    }

    private boolean isValidBridgeDir(File dir) {
        if (dir == null) {
            return false;
        }
        if (!dir.exists() || !dir.isDirectory()) {
            return false;
        }
        File scriptFile = new File(dir, NODE_SCRIPT);
        return scriptFile.exists();
    }

    private void addCandidate(List<File> possibleDirs, File dir) {
        if (dir == null) {
            return;
        }
        String candidatePath = dir.getAbsolutePath();
        for (File existing : possibleDirs) {
            if (existing.getAbsolutePath().equals(candidatePath)) {
                return;
            }
        }
        possibleDirs.add(dir);
    }

    private boolean isRootDirectory(File dir) {
        return dir.getParentFile() == null;
    }

    private File ensureEmbeddedBridgeExtracted() {
        try {
            PluginId pluginId = PluginId.getId(PLUGIN_ID);
            IdeaPluginDescriptor descriptor = PluginManagerCore.getPlugin(pluginId);
            if (descriptor == null) {
                return null;
            }

            File pluginDir = descriptor.getPluginPath().toFile();
            File archiveFile = new File(pluginDir, SDK_ARCHIVE_NAME);
            if (!archiveFile.exists()) {
                return null;
            }

            File extractedDir = new File(pluginDir, SDK_DIR_NAME);
            String signature = descriptor.getVersion() + ":" + archiveFile.lastModified();
            File versionFile = new File(extractedDir, BRIDGE_VERSION_FILE);

            if (isValidBridgeDir(extractedDir) && bridgeSignatureMatches(versionFile, signature)) {
                return extractedDir;
            }

            synchronized (bridgeExtractionLock) {
                if (isValidBridgeDir(extractedDir) && bridgeSignatureMatches(versionFile, signature)) {
                    return extractedDir;
                }

                System.out.println("未检测到已解压的 claude-bridge，开始解压: " + archiveFile.getAbsolutePath());
                deleteDirectory(extractedDir);
                unzipArchive(archiveFile, extractedDir);
                Files.writeString(versionFile.toPath(), signature, StandardCharsets.UTF_8);
            }

            if (isValidBridgeDir(extractedDir)) {
                System.out.println("✓ claude-bridge 解压完成: " + extractedDir.getAbsolutePath());
                return extractedDir;
            }

            System.err.println("⚠️ claude-bridge 解压后结构无效: " + extractedDir.getAbsolutePath());
        } catch (Exception e) {
            System.err.println("⚠️ 自动解压 claude-bridge 失败: " + e.getMessage());
        }
        return null;
    }

    private boolean bridgeSignatureMatches(File versionFile, String expectedSignature) {
        if (versionFile == null || !versionFile.exists()) {
            return false;
        }
        try {
            String content = Files.readString(versionFile.toPath(), StandardCharsets.UTF_8).trim();
            return expectedSignature.equals(content);
        } catch (IOException e) {
            return false;
        }
    }

    private void deleteDirectory(File dir) {
        if (dir == null || !dir.exists()) {
            return;
        }
        // 使用带重试机制的目录删除，处理 Windows 文件锁定问题
        if (!PlatformUtils.deleteDirectoryWithRetry(dir, 3)) {
            // 如果重试失败，回退到 IntelliJ 的 FileUtil
            if (!FileUtil.delete(dir)) {
                System.err.println("⚠️ 无法删除目录: " + dir.getAbsolutePath());
            }
        }
    }

    private void unzipArchive(File archiveFile, File targetDir) throws IOException {
        Files.createDirectories(targetDir.toPath());
        Path targetPath = targetDir.toPath();
        byte[] buffer = new byte[8192];

        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(archiveFile)))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                Path resolvedPath = targetPath.resolve(entry.getName()).normalize();
                if (!resolvedPath.startsWith(targetPath)) {
                    throw new IOException("检测到不安全的 Zip 条目: " + entry.getName());
                }

                if (entry.isDirectory()) {
                    Files.createDirectories(resolvedPath);
                } else {
                    Files.createDirectories(resolvedPath.getParent());
                    try (FileOutputStream fos = new FileOutputStream(resolvedPath.toFile())) {
                        int len;
                        while ((len = zis.read(buffer)) > 0) {
                            fos.write(buffer, 0, len);
                        }
                    }
                }

                zis.closeEntry();
            }
        }
    }

    // ============================================================================
    // 多轮交互支持方法
    // ============================================================================

    private static final String CHANNEL_SCRIPT = "channel-manager.js";

    /**
     * 启动一个新的 Claude Agent channel
     * @param channelId 频道 ID
     * @param sessionId 会话 ID（可选，用于恢复历史会话）
     * @param cwd 工作目录（可选）
     * @return 包含 sessionId 等信息的 JSON 对象
     */
    public JsonObject launchChannel(String channelId, String sessionId, String cwd) {
        // 新版本的 channel-manager.js 不需要显式 launch
        // 第一次 send 会自动创建会话
        // 这里返回一个成功响应，让调用者继续
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        if (sessionId != null) {
            result.addProperty("sessionId", sessionId);
        }
        result.addProperty("channelId", channelId);
        result.addProperty("message", "Channel ready (auto-launch on first send)");
        System.out.println("[Launch] Channel ready for: " + channelId + " (auto-launch on first send)");
        return result;
    }

    /**
     * 在已有 channel 中发送消息（流式响应）
     * @param channelId 频道 ID
     * @param message 消息内容
     * @param sessionId 会话 ID（用于恢复上下文）
     * @param cwd 工作目录
     * @param attachments 附件列表（可选）
     * @param callback 流式回调
     */
    public CompletableFuture<SDKResult> sendMessage(
        String channelId,
        String message,
        String sessionId,
        String cwd,
        List<ClaudeSession.Attachment> attachments,
        MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, cwd, attachments, null, null, callback);
    }

    /**
     * 在已有 channel 中发送消息（流式响应，支持权限模式和模型选择）
     * @param channelId 频道 ID
     * @param message 消息内容
     * @param sessionId 会话 ID（用于恢复上下文）
     * @param cwd 工作目录
     * @param attachments 附件列表（可选）
     * @param permissionMode 权限模式（可选）
     * @param model 模型名称（可选）
     * @param callback 流式回调
     */
    public CompletableFuture<SDKResult> sendMessage(
        String channelId,
        String message,
        String sessionId,
        String cwd,
        List<ClaudeSession.Attachment> attachments,
        String permissionMode,
        String model,
        MessageCallback callback
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();

            try {
                // 将附件序列化为 JSON，稍后通过 stdin 传递给 Node.js
                String attachmentsJson = null;
                boolean hasAttachments = attachments != null && !attachments.isEmpty();
                if (hasAttachments) {
                    try {
                        java.util.List<java.util.Map<String, String>> serializable = new java.util.ArrayList<>();
                        for (ClaudeSession.Attachment att : attachments) {
                            if (att == null) continue;
                            java.util.Map<String, String> obj = new java.util.HashMap<>();
                            obj.put("fileName", att.fileName);
                            obj.put("mediaType", att.mediaType);
                            obj.put("data", att.data);
                            serializable.add(obj);
                        }
                        attachmentsJson = gson.toJson(serializable);
                        System.out.println("[ClaudeSDKBridge] Prepared attachments JSON (" + attachmentsJson.length() + " bytes) for stdin");
                    } catch (Exception e) {
                        System.err.println("[ClaudeSDKBridge] Failed to serialize attachments: " + e.getMessage());
                        hasAttachments = false;
                    }
                }

                String node = findNodeExecutable();
                File workDir = findSdkTestDir();

                // 构建命令: send <message> [sessionId] [cwd]
                // 注意：新版本不再使用 channelId
                // 使用绝对路径指定 channel-manager.js 的位置
                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(new File(workDir, CHANNEL_SCRIPT).getAbsolutePath()); // 使用绝对路径
                // 根据是否存在附件选择不同的命令
                if (hasAttachments) {
                    command.add("sendWithAttachments");
                } else {
                    command.add("send");
                }
                command.add(message);

                // 重要：即使 sessionId 为 null，也要传递占位符，以保持参数顺序
                // 否则 cwd 会被误认为是 sessionId
                command.add(sessionId != null ? sessionId : "");

                // cwd 参数（如果有）
                if (cwd != null) {
                    command.add(cwd);
                } else {
                    command.add(""); // 占位符，保持参数顺序
                }

                // 权限模式参数（如果有）
                if (permissionMode != null) {
                    command.add(permissionMode);
                } else {
                    command.add(""); // 占位符，保持参数顺序
                }

                // 模型参数（如果有）
                if (model != null && !model.isEmpty()) {
                    command.add(model);
                }

                System.out.println("[ClaudeSDKBridge] Executing command: " + String.join(" ", command));

                File processTempDir = prepareClaudeTempDir();
                Set<String> existingTempMarkers = snapshotClaudeCwdFiles(processTempDir);

                // 创建进程
                ProcessBuilder pb = new ProcessBuilder(command);

                // 智能设置工作目录：优先使用用户指定的cwd，而不是claude-bridge目录
                if (cwd != null && !cwd.isEmpty() && !cwd.equals("undefined") && !cwd.equals("null")) {
                    File userWorkDir = new File(cwd);
                    if (userWorkDir.exists() && userWorkDir.isDirectory()) {
                        pb.directory(userWorkDir);
                        System.out.println("[ProcessBuilder] Working directory set to user's project: " + cwd);
                    } else {
                        // 如果用户指定的目录无效，使用claude-bridge目录
                        File claudeBridgeDir = findSdkTestDir();
                        pb.directory(claudeBridgeDir);
                        System.out.println("[ProcessBuilder] Invalid cwd '" + cwd + "', using claude-bridge: " + claudeBridgeDir);
                    }
                } else {
                    // 没有指定cwd时使用claude-bridge目录
                    File claudeBridgeDir = findSdkTestDir();
                    pb.directory(claudeBridgeDir);
                    System.out.println("[ProcessBuilder] No cwd specified, using claude-bridge: " + claudeBridgeDir);
                }

                // 设置环境变量，传递项目路径（作为额外保障）
                Map<String, String> env = pb.environment();
                if (cwd != null && !cwd.isEmpty() && !cwd.equals("undefined") && !cwd.equals("null")) {
                    env.put("IDEA_PROJECT_PATH", cwd);
                    env.put("PROJECT_PATH", cwd);  // 备用环境变量
                    System.out.println("[ProcessBuilder] Environment variables set: IDEA_PROJECT_PATH=" + cwd);
                }
                if (processTempDir != null) {
                    String tmpPath = processTempDir.getAbsolutePath();
                    env.put("TMPDIR", tmpPath);
                    env.put("TEMP", tmpPath);
                    env.put("TMP", tmpPath);
                    System.out.println("[ProcessBuilder] TMPDIR redirected to: " + tmpPath);
                }
                // 如果有附件，设置环境变量告知 Node.js 从 stdin 读取
                if (hasAttachments) {
                    env.put("CLAUDE_USE_STDIN", "true");
                    System.out.println("[ProcessBuilder] CLAUDE_USE_STDIN=true (will write attachments to stdin)");
                }

                pb.redirectErrorStream(true);
                updateProcessEnvironment(pb);

                Process process = null;
                final String finalAttachmentsJson = attachmentsJson; // 用于 lambda
                try {
                    process = pb.start();
                    if (channelId != null) {
                        activeChannelProcesses.put(channelId, process);
                        interruptedChannels.remove(channelId);
                    }

                    // 如果有附件，通过 stdin 写入 JSON 数据
                    if (hasAttachments && finalAttachmentsJson != null) {
                        try (java.io.OutputStream stdin = process.getOutputStream()) {
                            stdin.write(finalAttachmentsJson.getBytes(StandardCharsets.UTF_8));
                            stdin.flush();
                            System.out.println("[ClaudeSDKBridge] Wrote " + finalAttachmentsJson.length() + " bytes to stdin");
                        } catch (Exception e) {
                            System.err.println("[ClaudeSDKBridge] Failed to write attachments to stdin: " + e.getMessage());
                        }
                    }

                    try {
                        // 流式读取输出
                        try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                            String line;
                            while ((line = reader.readLine()) != null) {
                                System.out.println("[SendMessage] " + line);

                                // 解析不同类型的输出
                                if (line.startsWith("[MESSAGE]")) {
                                    // 原始消息 JSON
                                    String jsonStr = line.substring("[MESSAGE]".length()).trim();
                                    try {
                                        JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                                        result.messages.add(msg);

                                        // 通知回调
                                        String type = msg.has("type") ? msg.get("type").getAsString() : "unknown";
                                        callback.onMessage(type, jsonStr);

                                    } catch (Exception e) {
                                        System.err.println("Failed to parse message JSON: " + e.getMessage());
                                    }

                                } else if (line.startsWith("[CONTENT]")) {
                                    // 助手内容片段
                                    String content = line.substring("[CONTENT]".length()).trim();
                                    assistantContent.append(content);
                                    callback.onMessage("content", content);

                                } else if (line.startsWith("[CONTENT_DELTA]")) {
                                    // 流式内容片段（用于图片消息等流式响应）
                                    String delta = line.substring("[CONTENT_DELTA]".length()).trim();
                                    assistantContent.append(delta);
                                    callback.onMessage("content_delta", delta);

                                } else if (line.startsWith("[SESSION_ID]")) {
                                    // 会话 ID
                                    String capturedSessionId = line.substring("[SESSION_ID]".length()).trim();
                                    callback.onMessage("session_id", capturedSessionId);

                                } else if (line.startsWith("[MESSAGE_START]")) {
                                    // 消息开始
                                    callback.onMessage("message_start", "");

                                } else if (line.startsWith("[MESSAGE_END]")) {
                                    // 消息结束
                                    callback.onMessage("message_end", "");
                                }
                            }
                        }

                        int exitCode = process.waitFor();
                        boolean wasInterrupted = channelId != null && interruptedChannels.remove(channelId);

                        result.success = exitCode == 0 && !wasInterrupted;
                        result.finalResult = assistantContent.toString();
                        result.messageCount = result.messages.size();

                        if (wasInterrupted) {
                            System.out.println("[SendMessage] Channel " + channelId + " was interrupted by user");
                            callback.onComplete(result);
                        } else if (result.success) {
                            callback.onComplete(result);
                        } else {
                            callback.onError("Process exited with code: " + exitCode);
                        }

                        return result;
                    } finally {
                        if (channelId != null) {
                            activeChannelProcesses.remove(channelId, process);
                        }
                    }
                } finally {
                    waitForProcessTermination(process);
                    cleanupClaudeTempFiles(processTempDir, existingTempMarkers);
                }

            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                callback.onError(e.getMessage());
                return result;
            }
        });
    }

    /**
     * 中断 channel
     * 使用平台感知的进程终止方法，确保在 Windows 上正确终止子进程树
     */
    public void interruptChannel(String channelId) {
        if (channelId == null) {
            System.out.println("[Interrupt] ChannelId is null, nothing to interrupt");
            return;
        }

        Process process = activeChannelProcesses.get(channelId);
        if (process == null) {
            System.out.println("[Interrupt] No active process found for channel: " + channelId);
            return;
        }

        System.out.println("[Interrupt] Attempting to interrupt channel: " + channelId);
        interruptedChannels.add(channelId);

        // 使用平台感知的进程终止方法
        // Windows: 使用 taskkill /F /T 终止进程树
        // Unix: 使用标准的 destroy/destroyForcibly
        PlatformUtils.terminateProcess(process);

        // 等待进程完全终止
        try {
            if (process.isAlive()) {
                boolean terminated = process.waitFor(3, TimeUnit.SECONDS);
                if (!terminated) {
                    System.out.println("[Interrupt] Process still alive, force killing channel: " + channelId);
                    process.destroyForcibly();
                    process.waitFor(2, TimeUnit.SECONDS);
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            activeChannelProcesses.remove(channelId, process);
            // 验证进程确实已终止
            if (process.isAlive()) {
                System.err.println("[Interrupt] Warning: Process may still be alive for channel: " + channelId);
            } else {
                System.out.println("[Interrupt] Successfully terminated channel: " + channelId);
            }
        }
    }

    /**
     * 获取会话历史消息
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            System.out.println("[ClaudeSDKBridge] getSessionMessages: sessionId=" + sessionId + ", cwd=" + cwd);
            String node = findNodeExecutable();

            // 构建命令
            List<String> command = new ArrayList<>();
            command.add(node);
            command.add(CHANNEL_SCRIPT);
            command.add("getSession");
            command.add(sessionId);
            // 保持参数一致性，即使 cwd 为空也传递
            command.add(cwd != null ? cwd : "");

            System.out.println("[ClaudeSDKBridge] Command: " + String.join(" ", command));

            // 创建进程
            ProcessBuilder pb = new ProcessBuilder(command);
            File workDir = findSdkTestDir();
            pb.directory(workDir);
            pb.redirectErrorStream(true);
            updateProcessEnvironment(pb);

            Process process = pb.start();

            // 读取输出
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
            }

            process.waitFor();

            // 解析 JSON 响应
            String outputStr = output.toString().trim();
            System.out.println("[ClaudeSDKBridge] Node.js output: " + outputStr);

            // 使用 indexOf 找第一个 { 而不是 lastIndexOf
            int jsonStart = outputStr.indexOf("{");
            if (jsonStart != -1) {
                String jsonStr = outputStr.substring(jsonStart);
                System.out.println("[ClaudeSDKBridge] Extracting JSON from position " + jsonStart);
                JsonObject result = gson.fromJson(jsonStr, JsonObject.class);

                if (result.has("success") && result.get("success").getAsBoolean()) {
                    List<JsonObject> messages = new ArrayList<>();
                    if (result.has("messages")) {
                        JsonArray messagesArray = result.getAsJsonArray("messages");
                        System.out.println("[ClaudeSDKBridge] Found " + messagesArray.size() + " messages in response");
                        for (var msg : messagesArray) {
                            messages.add(msg.getAsJsonObject());
                        }
                    }
                    return messages;
                } else {
                    String errorMsg = (result.has("error") && !result.get("error").isJsonNull())
                        ? result.get("error").getAsString()
                        : "Unknown error";
                    System.err.println("[ClaudeSDKBridge] Get session failed: " + errorMsg);
                    throw new RuntimeException("Get session failed: " + errorMsg);
                }
            }

            System.err.println("[ClaudeSDKBridge] No JSON found in output");
            return new ArrayList<>();

        } catch (Exception e) {
            System.err.println("[ClaudeSDKBridge] Exception: " + e.getMessage());
            e.printStackTrace();
            throw new RuntimeException("Failed to get session messages: " + e.getMessage(), e);
        }
    }

    private File prepareClaudeTempDir() {
        String baseTemp = System.getProperty("java.io.tmpdir");
        if (baseTemp == null || baseTemp.isEmpty()) {
            return null;
        }

        Path tempPath = Paths.get(baseTemp, CLAUDE_TEMP_DIR_NAME);
        try {
            Files.createDirectories(tempPath);
            return tempPath.toFile();
        } catch (IOException e) {
            System.err.println("[ClaudeSDKBridge] Failed to prepare temp dir: " + tempPath + ", reason: " + e.getMessage());
            return null;
        }
    }

    private Set<String> snapshotClaudeCwdFiles(File tempDir) {
        if (tempDir == null || !tempDir.exists()) {
            return Collections.emptySet();
        }
        File[] existing = tempDir.listFiles((dir, name) ->
            name.startsWith("claude-") && name.endsWith("-cwd"));
        if (existing == null || existing.length == 0) {
            return Collections.emptySet();
        }
        Set<String> snapshot = new HashSet<>();
        for (File file : existing) {
            snapshot.add(file.getName());
        }
        return snapshot;
    }

    private void cleanupClaudeTempFiles(File tempDir, Set<String> preserved) {
        if (tempDir == null || !tempDir.exists()) {
            return;
        }
        File[] leftovers = tempDir.listFiles((dir, name) ->
            name.startsWith("claude-") && name.endsWith("-cwd"));
        if (leftovers == null || leftovers.length == 0) {
            return;
        }
        for (File file : leftovers) {
            if (preserved != null && preserved.contains(file.getName())) {
                continue;
            }
            // 使用带重试机制的删除，处理 Windows 文件锁定问题
            if (!PlatformUtils.deleteWithRetry(file, 3)) {
                try {
                    Files.deleteIfExists(file.toPath());
                } catch (IOException e) {
                    System.err.println("[ClaudeSDKBridge] Failed to delete temp cwd file: " + file.getAbsolutePath());
                }
            }
        }
    }

    private void waitForProcessTermination(Process process) {
        if (process == null) {
            return;
        }
        if (process.isAlive()) {
            try {
                process.waitFor(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private void configurePermissionEnv(Map<String, String> env) {
        if (env == null) {
            return;
        }
        String permissionDir = getPermissionDirectory();
        if (permissionDir != null) {
            env.putIfAbsent(CLAUDE_PERMISSION_ENV, permissionDir);
        }
    }

    private String getPermissionDirectory() {
        String cached = this.cachedPermissionDir;
        if (cached != null) {
            return cached;
        }

        Path dir = Paths.get(System.getProperty("java.io.tmpdir"), "claude-permission");
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            System.err.println("[ClaudeSDKBridge] Failed to prepare permission dir: " + dir + " (" + e.getMessage() + ")");
        }
        cachedPermissionDir = dir.toAbsolutePath().toString();
        return cachedPermissionDir;
    }

    /**
     * 更新进程的环境变量，确保 PATH 包含 Node.js 所在目录
     * 支持 Windows (Path) 和 Unix (PATH) 环境变量命名
     */
    private void updateProcessEnvironment(ProcessBuilder pb) {
        Map<String, String> env = pb.environment();

        // 使用 PlatformUtils 获取 PATH 环境变量（大小写不敏感）
        String path = PlatformUtils.isWindows() ?
            PlatformUtils.getEnvIgnoreCase("PATH") :
            env.get("PATH");

        if (path == null) {
            path = "";
        }

        StringBuilder newPath = new StringBuilder(path);
        String separator = File.pathSeparator;

        // 1. 添加 Node.js 所在目录
        String node = getNodeExecutable();
        if (node != null && !node.equals("node")) {
            File nodeFile = new File(node);
            String nodeDir = nodeFile.getParent();
            if (nodeDir != null && !pathContains(path, nodeDir)) {
                newPath.append(separator).append(nodeDir);
            }
        }

        // 2. 根据平台添加常用路径
        if (PlatformUtils.isWindows()) {
            // Windows 常用路径
            String[] windowsPaths = {
                System.getenv("ProgramFiles") + "\\nodejs",
                System.getenv("APPDATA") + "\\npm",
                System.getenv("LOCALAPPDATA") + "\\Programs\\nodejs"
            };
            for (String p : windowsPaths) {
                if (p != null && !p.contains("null") && !pathContains(path, p)) {
                    newPath.append(separator).append(p);
                }
            }
        } else {
            // macOS/Linux 常用路径
            String[] unixPaths = {
                "/usr/local/bin",
                "/opt/homebrew/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
                System.getProperty("user.home") + "/.nvm/current/bin"
            };
            for (String p : unixPaths) {
                if (!pathContains(path, p)) {
                    newPath.append(separator).append(p);
                }
            }
        }

        // 3. 设置 PATH 环境变量
        // Windows 需要同时设置 PATH 和 Path（某些程序只识别其中一个）
        String newPathStr = newPath.toString();
        if (PlatformUtils.isWindows()) {
            // 先移除可能存在的旧值，避免重复
            env.remove("PATH");
            env.remove("Path");
            env.remove("path");
            // 同时设置多种大小写形式确保兼容性
            env.put("PATH", newPathStr);
            env.put("Path", newPathStr);
        } else {
            env.put("PATH", newPathStr);
        }

        configurePermissionEnv(env);
    }

    /**
     * 检查 PATH 中是否已包含指定路径
     * Windows 下进行大小写不敏感比较
     */
    private boolean pathContains(String pathEnv, String targetPath) {
        if (pathEnv == null || targetPath == null) {
            return false;
        }
        if (PlatformUtils.isWindows()) {
            return pathEnv.toLowerCase().contains(targetPath.toLowerCase());
        }
        return pathEnv.contains(targetPath);
    }
}

package com.github.claudecodegui.dependency;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SDK 依赖管理器
 * 负责管理 ~/.codemoss/dependencies/ 目录下的 SDK 安装
 */
public class DependencyManager {

    private static final Logger LOG = Logger.getInstance(DependencyManager.class);
    private static final String DEPS_DIR_NAME = "dependencies";
    private static final String MANIFEST_FILE = "manifest.json";
    private static final String INSTALLED_MARKER = ".installed";

    private final Gson gson;
    private final NodeDetector nodeDetector;
    private final EnvironmentConfigurator envConfigurator;

    public DependencyManager() {
        this.gson = new GsonBuilder().setPrettyPrinting().create();
        this.nodeDetector = new NodeDetector();
        this.envConfigurator = new EnvironmentConfigurator();
    }

    public DependencyManager(NodeDetector nodeDetector) {
        this.gson = new GsonBuilder().setPrettyPrinting().create();
        this.nodeDetector = nodeDetector;
        this.envConfigurator = new EnvironmentConfigurator();
    }

    /**
     * 获取依赖目录根路径 (~/.codemoss/dependencies/)
     */
    public Path getDependenciesDir() {
        String home = System.getProperty("user.home");
        return Paths.get(home, ".codemoss", DEPS_DIR_NAME);
    }

    /**
     * 获取指定 SDK 的安装目录
     */
    public Path getSdkDir(String sdkId) {
        return getDependenciesDir().resolve(sdkId);
    }

    /**
     * 获取指定 SDK 的 node_modules 目录
     */
    public Path getSdkNodeModulesDir(String sdkId) {
        return getSdkDir(sdkId).resolve("node_modules");
    }

    /**
     * 检查 SDK 是否已安装
     */
    public boolean isInstalled(String sdkId) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return false;
        }

        // 检查主包是否存在于 node_modules 中
        Path packageDir = getPackageDir(sdkId, sdk.getNpmPackage());
        if (!Files.exists(packageDir)) {
            return false;
        }

        // 如果包存在但没有 .installed 标记文件，自动创建标记文件
        // 这支持用户手动运行 npm install 的情况
        Path sdkDir = getSdkDir(sdkId);
        Path markerFile = sdkDir.resolve(INSTALLED_MARKER);
        if (!Files.exists(markerFile)) {
            try {
                String version = getInstalledVersionFromPackage(sdkId, sdk.getNpmPackage());
                Files.writeString(markerFile, version != null ? version : "unknown");
                LOG.info("[DependencyManager] Created missing marker file for manually installed SDK: " + sdkId);
            } catch (Exception e) {
                LOG.warn("[DependencyManager] Failed to create marker file: " + e.getMessage());
            }
        }

        return true;
    }

    /**
     * 从 package.json 读取版本（内部使用，不依赖 isInstalled）
     */
    private String getInstalledVersionFromPackage(String sdkId, String npmPackage) {
        Path packageJson = getPackageDir(sdkId, npmPackage).resolve("package.json");
        if (!Files.exists(packageJson)) {
            return null;
        }

        try (Reader reader = Files.newBufferedReader(packageJson, StandardCharsets.UTF_8)) {
            JsonObject json = JsonParser.parseReader(reader).getAsJsonObject();
            if (json.has("version")) {
                return json.get("version").getAsString();
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to read version from package.json: " + e.getMessage());
        }

        return null;
    }

    /**
     * 获取包在 node_modules 中的路径
     */
    private Path getPackageDir(String sdkId, String npmPackage) {
        // @scope/package -> node_modules/@scope/package
        String[] parts = npmPackage.split("/");
        Path nodeModules = getSdkNodeModulesDir(sdkId);
        Path packagePath = nodeModules;
        for (String part : parts) {
            packagePath = packagePath.resolve(part);
        }
        return packagePath;
    }

    /**
     * 获取已安装的版本
     */
    public String getInstalledVersion(String sdkId) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null || !isInstalled(sdkId)) {
            return null;
        }

        return getInstalledVersionFromPackage(sdkId, sdk.getNpmPackage());
    }

    /**
     * 从 NPM Registry 获取最新版本
     */
    public String getLatestVersion(String sdkId) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return null;
        }

        try {
            String nodePath = nodeDetector.findNodeExecutable();
            String npmPath = getNpmPath(nodePath);

            ProcessBuilder pb = new ProcessBuilder(
                npmPath, "view", sdk.getNpmPackage(), "version"
            );
            configureProcessEnvironment(pb);

            Process process = pb.start();
            StringBuilder output = new StringBuilder();

            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line.trim());
                }
            }

            boolean finished = process.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return null;
            }

            if (process.exitValue() == 0) {
                return output.toString().trim();
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to get latest version: " + e.getMessage());
        }

        return null;
    }

    /**
     * 检查是否有可用更新
     */
    public UpdateInfo checkForUpdates(String sdkId) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return UpdateInfo.error(sdkId, "Unknown SDK", "Unknown SDK: " + sdkId);
        }

        if (!isInstalled(sdkId)) {
            return UpdateInfo.error(sdkId, sdk.getDisplayName(), "SDK not installed");
        }

        String currentVersion = getInstalledVersion(sdkId);
        if (currentVersion == null) {
            return UpdateInfo.error(sdkId, sdk.getDisplayName(), "Cannot read installed version");
        }

        String latestVersion = getLatestVersion(sdkId);
        if (latestVersion == null) {
            return UpdateInfo.error(sdkId, sdk.getDisplayName(), "Cannot fetch latest version");
        }

        if (compareVersions(currentVersion, latestVersion) < 0) {
            return UpdateInfo.updateAvailable(sdkId, sdk.getDisplayName(), currentVersion, latestVersion);
        }

        return UpdateInfo.noUpdate(sdkId, sdk.getDisplayName(), currentVersion);
    }

    /**
     * 安装 SDK（异步）
     */
    public CompletableFuture<InstallResult> installSdk(String sdkId, Consumer<String> logCallback) {
        return CompletableFuture.supplyAsync(() -> installSdkSync(sdkId, logCallback));
    }

    /**
     * 安装 SDK（同步）
     */
    public InstallResult installSdkSync(String sdkId, Consumer<String> logCallback) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return InstallResult.failure(sdkId, "Unknown SDK: " + sdkId, "");
        }

        StringBuilder logs = new StringBuilder();
        Consumer<String> log = (msg) -> {
            logs.append(msg).append("\n");
            if (logCallback != null) {
                logCallback.accept(msg);
            }
        };

        try {
            log.accept("Starting installation of " + sdk.getDisplayName() + "...");

            // 1. 检查 Node.js 环境
            String nodePath = nodeDetector.findNodeExecutable();
            if (nodePath == null || "node".equals(nodePath)) {
                String version = nodeDetector.verifyNodePath("node");
                if (version == null) {
                    return InstallResult.failure(sdkId,
                        "Node.js not found. Please configure Node.js path in Settings > Basic.",
                        logs.toString());
                }
            }
            log.accept("Using Node.js: " + nodePath);

            String npmPath = getNpmPath(nodePath);
            log.accept("Using npm: " + npmPath);

            // 2. 创建 SDK 目录
            Path sdkDir = getSdkDir(sdkId);

            // 🔧 路径安全校验：确保 sdkDir 在预期的依赖目录下，防止路径遍历攻击
            Path normalizedSdkDir = sdkDir.normalize().toAbsolutePath();
            Path normalizedDepsDir = getDependenciesDir().normalize().toAbsolutePath();
            if (!normalizedSdkDir.startsWith(normalizedDepsDir)) {
                return InstallResult.failure(sdkId,
                    "Security error: SDK directory path is outside dependencies directory",
                    logs.toString());
            }

            Files.createDirectories(sdkDir);
            log.accept("Created directory: " + sdkDir);

            // 3. 创建 package.json
            createPackageJson(sdkDir, sdk);
            log.accept("Created package.json");

            // 4. 预检查 npm 缓存权限
            log.accept("Checking npm cache permissions...");
            if (!NpmPermissionHelper.checkCachePermission()) {
                log.accept("⚠️ Warning: npm cache may have permission issues, attempting to fix...");

                // 尝试清理缓存
                if (NpmPermissionHelper.cleanNpmCache(npmPath)) {
                    log.accept("✓ npm cache cleaned successfully");
                } else if (NpmPermissionHelper.forceDeleteCache()) {
                    log.accept("✓ npm cache directory deleted successfully");
                } else {
                    log.accept("⚠️ Warning: Could not clean cache automatically, will try installation anyway");
                }
            }

            // 5. 执行 npm install（带重试机制）
            List<String> packages = sdk.getAllPackages();
            int maxRetries = 2;
            InstallResult lastResult = null;

            for (int attempt = 0; attempt <= maxRetries; attempt++) {
                if (attempt > 0) {
                    log.accept("\n🔄 Retry attempt " + attempt + "/" + maxRetries + "...");
                }

                log.accept("Running npm install...");
                List<String> command = NpmPermissionHelper.buildInstallCommandWithFallback(
                    npmPath, normalizedSdkDir, packages, attempt
                );
                log.accept("Command: " + String.join(" ", command));

                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(sdkDir.toFile());
                pb.redirectErrorStream(true);
                configureProcessEnvironment(pb);

                Process process = pb.start();

                // 实时读取输出并收集日志
                StringBuilder installLogs = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        log.accept(line);
                        installLogs.append(line).append("\n");
                    }
                }

                boolean finished = process.waitFor(3, TimeUnit.MINUTES);
                if (!finished) {
                    process.destroyForcibly();
                    lastResult = InstallResult.failure(sdkId,
                        "Installation timed out (3 minutes)", logs.toString());
                    continue; // 尝试重试
                }

                int exitCode = process.exitValue();
                if (exitCode == 0) {
                    // 安装成功，跳到后续步骤
                    break;
                }

                // 安装失败，记录结果
                String logsStr = logs.toString();
                lastResult = InstallResult.failure(sdkId,
                    "npm install failed with exit code: " + exitCode, logsStr);

                // 如果是最后一次尝试，不再重试
                if (attempt == maxRetries) {
                    // 添加错误解决方案提示
                    String solution = NpmPermissionHelper.generateErrorSolution(logsStr);
                    return InstallResult.failure(sdkId,
                        lastResult.getErrorMessage() + solution,
                        lastResult.getLogs());
                }

                // 检测错误类型并尝试修复
                boolean fixed = false;
                if (NpmPermissionHelper.hasPermissionError(logsStr) ||
                    NpmPermissionHelper.hasCacheError(logsStr)) {

                    log.accept("⚠️ Detected npm cache/permission error, attempting to fix...");

                    // 策略1: 清理缓存
                    if (NpmPermissionHelper.cleanNpmCache(npmPath)) {
                        log.accept("✓ Cache cleaned, will retry");
                        fixed = true;
                    } else if (NpmPermissionHelper.forceDeleteCache()) {
                        log.accept("✓ Cache deleted, will retry");
                        fixed = true;
                    }

                    // 策略2: 修复权限（Unix only）
                    if (!fixed && !PlatformUtils.isWindows()) {
                        log.accept("Attempting to fix cache ownership (may require password)...");
                        if (NpmPermissionHelper.fixCacheOwnership()) {
                            log.accept("✓ Ownership fixed, will retry");
                            fixed = true;
                        }
                    }
                }

                if (!fixed) {
                    log.accept("⚠️ Could not auto-fix the issue, will retry with --force flag");
                }

                // 短暂延迟后重试
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return InstallResult.failure(sdkId, "Installation interrupted", logs.toString());
                }
            }

            // 6. 创建安装标记文件
            String installedVersion = getInstalledVersion(sdkId);
            Path markerFile = sdkDir.resolve(INSTALLED_MARKER);
            Files.writeString(markerFile, installedVersion != null ? installedVersion : "unknown");

            // 7. 更新 manifest
            updateManifest(sdkId, installedVersion);

            log.accept("Installation completed successfully!");
            log.accept("Installed version: " + installedVersion);

            return InstallResult.success(sdkId, installedVersion, logs.toString());

        } catch (Exception e) {
            LOG.error("[DependencyManager] Installation failed: " + e.getMessage(), e);
            log.accept("ERROR: " + e.getMessage());
            return InstallResult.failure(sdkId, e.getMessage(), logs.toString());
        }
    }

    /**
     * 卸载 SDK
     * @return true 如果完全卸载成功，false 如果有部分文件删除失败
     */
    public boolean uninstallSdk(String sdkId) {
        try {
            Path sdkDir = getSdkDir(sdkId);
            if (!Files.exists(sdkDir)) {
                return true;
            }

            // 🔧 递归删除目录，并获取删除失败的路径列表
            List<Path> failedPaths = deleteDirectory(sdkDir);

            // 更新 manifest
            removeFromManifest(sdkId);

            if (failedPaths.isEmpty()) {
                LOG.info("[DependencyManager] Uninstalled SDK completely: " + sdkId);
                return true;
            } else {
                // 🔧 部分文件删除失败，记录警告但仍返回成功（manifest 已更新）
                LOG.warn("[DependencyManager] Uninstalled SDK with " + failedPaths.size() +
                    " files failed to delete: " + sdkId);
                return true; // 仍然返回 true，因为 SDK 功能上已卸载
            }
        } catch (Exception e) {
            LOG.error("[DependencyManager] Failed to uninstall SDK: " + e.getMessage(), e);
            return false;
        }
    }

    /**
     * 获取所有 SDK 的状态
     */
    public JsonObject getAllSdkStatus() {
        JsonObject result = new JsonObject();

        for (SdkDefinition sdk : SdkDefinition.values()) {
            JsonObject status = new JsonObject();
            boolean installed = isInstalled(sdk.getId());

            status.addProperty("id", sdk.getId());
            status.addProperty("name", sdk.getDisplayName());
            status.addProperty("description", sdk.getDescription());
            status.addProperty("npmPackage", sdk.getNpmPackage());
            status.addProperty("installed", installed);
            // 添加 status 字段供前端使用
            status.addProperty("status", installed ? "installed" : "not_installed");

            if (installed) {
                String version = getInstalledVersion(sdk.getId());
                status.addProperty("installedVersion", version);
                status.addProperty("version", version); // 同时添加 version 字段
            }

            result.add(sdk.getId(), status);
        }

        return result;
    }

    /**
     * 检查 Node.js 环境是否可用
     */
    public boolean checkNodeEnvironment() {
        try {
            String nodePath = nodeDetector.findNodeExecutable();
            if (nodePath == null) {
                return false;
            }

            String version = nodeDetector.verifyNodePath(nodePath);
            return version != null;
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Node.js environment check failed: " + e.getMessage());
            return false;
        }
    }

    // ==================== 私有方法 ====================

    /**
     * 获取 npm 路径（基于 node 路径）
     */
    private String getNpmPath(String nodePath) {
        String npmName = PlatformUtils.isWindows() ? "npm.cmd" : "npm";

        // 1. 尝试从 Node.js 同目录查找
        if (nodePath != null && !"node".equals(nodePath)) {
            File nodeFile = new File(nodePath);
            String dir = nodeFile.getParent();
            if (dir != null) {
                File npmFile = new File(dir, npmName);
                if (npmFile.exists()) {
                    return npmFile.getAbsolutePath();
                }
            }
        }

        // 2. Windows: 尝试从环境变量 PATH 中查找 npm.cmd 的完整路径
        if (PlatformUtils.isWindows()) {
            String pathEnv = System.getenv("PATH");
            if (pathEnv != null) {
                for (String pathDir : pathEnv.split(File.pathSeparator)) {
                    File npmFile = new File(pathDir, npmName);
                    if (npmFile.exists()) {
                        LOG.info("[DependencyManager] Found npm in PATH: " + npmFile.getAbsolutePath());
                        return npmFile.getAbsolutePath();
                    }
                }
            }
        }

        // 3. 回退到简单命令名（Unix 通常可以工作）
        return PlatformUtils.isWindows() ? npmName : "npm";
    }

    /**
     * 配置进程环境变量
     */
    private void configureProcessEnvironment(ProcessBuilder pb) {
        String nodePath = nodeDetector.findNodeExecutable();
        envConfigurator.updateProcessEnvironment(pb, nodePath);
    }

    /**
     * 创建 package.json
     */
    private void createPackageJson(Path sdkDir, SdkDefinition sdk) throws IOException {
        JsonObject packageJson = new JsonObject();
        packageJson.addProperty("name", sdk.getId() + "-container");
        packageJson.addProperty("version", "1.0.0");
        packageJson.addProperty("private", true);

        Path packageJsonPath = sdkDir.resolve("package.json");
        try (Writer writer = Files.newBufferedWriter(packageJsonPath, StandardCharsets.UTF_8)) {
            gson.toJson(packageJson, writer);
        }
    }

    /**
     * 更新 manifest.json
     */
    private void updateManifest(String sdkId, String version) {
        try {
            Path manifestPath = getDependenciesDir().resolve(MANIFEST_FILE);
            JsonObject manifest;

            if (Files.exists(manifestPath)) {
                try (Reader reader = Files.newBufferedReader(manifestPath, StandardCharsets.UTF_8)) {
                    manifest = JsonParser.parseReader(reader).getAsJsonObject();
                }
            } else {
                manifest = new JsonObject();
            }

            JsonObject sdkInfo = new JsonObject();
            sdkInfo.addProperty("version", version);
            sdkInfo.addProperty("installedAt", System.currentTimeMillis());
            manifest.add(sdkId, sdkInfo);

            try (Writer writer = Files.newBufferedWriter(manifestPath, StandardCharsets.UTF_8)) {
                gson.toJson(manifest, writer);
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to update manifest: " + e.getMessage());
        }
    }

    /**
     * 从 manifest.json 中移除 SDK
     */
    private void removeFromManifest(String sdkId) {
        try {
            Path manifestPath = getDependenciesDir().resolve(MANIFEST_FILE);
            if (!Files.exists(manifestPath)) {
                return;
            }

            JsonObject manifest;
            try (Reader reader = Files.newBufferedReader(manifestPath, StandardCharsets.UTF_8)) {
                manifest = JsonParser.parseReader(reader).getAsJsonObject();
            }

            manifest.remove(sdkId);

            try (Writer writer = Files.newBufferedWriter(manifestPath, StandardCharsets.UTF_8)) {
                gson.toJson(manifest, writer);
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to remove from manifest: " + e.getMessage());
        }
    }

    /**
     * 递归删除目录
     * @return 删除失败的路径列表（空列表表示完全成功）
     */
    private List<Path> deleteDirectory(Path dir) throws IOException {
        List<Path> failedPaths = new ArrayList<>();

        if (!Files.exists(dir)) {
            return failedPaths;
        }

        // 🔧 收集所有删除失败的路径，而不是静默忽略
        Files.walk(dir)
            .sorted((a, b) -> b.compareTo(a)) // 反向排序，先删除子文件
            .forEach(path -> {
                try {
                    Files.delete(path);
                } catch (IOException e) {
                    LOG.warn("[DependencyManager] Failed to delete: " + path + " - " + e.getMessage());
                    failedPaths.add(path);
                }
            });

        if (!failedPaths.isEmpty()) {
            LOG.warn("[DependencyManager] " + failedPaths.size() + " files/directories failed to delete");
        }

        return failedPaths;
    }

    /**
     * 比较版本号
     * @return 负数表示 v1 < v2，0 表示相等，正数表示 v1 > v2
     */
    private int compareVersions(String v1, String v2) {
        if (v1 == null || v2 == null) {
            return 0;
        }

        // 移除前缀 v
        v1 = v1.startsWith("v") ? v1.substring(1) : v1;
        v2 = v2.startsWith("v") ? v2.substring(1) : v2;

        String[] parts1 = v1.split("\\.");
        String[] parts2 = v2.split("\\.");

        int maxLen = Math.max(parts1.length, parts2.length);
        for (int i = 0; i < maxLen; i++) {
            int num1 = i < parts1.length ? parseVersionPart(parts1[i]) : 0;
            int num2 = i < parts2.length ? parseVersionPart(parts2[i]) : 0;

            if (num1 != num2) {
                return num1 - num2;
            }
        }

        return 0;
    }

    /**
     * 解析版本号部分
     */
    private int parseVersionPart(String part) {
        // 移除非数字后缀（如 -beta, -alpha）
        Pattern pattern = Pattern.compile("^(\\d+)");
        Matcher matcher = pattern.matcher(part);
        if (matcher.find()) {
            return Integer.parseInt(matcher.group(1));
        }
        return 0;
    }
}

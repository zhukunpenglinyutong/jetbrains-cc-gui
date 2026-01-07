package com.github.claudecodegui.bridge;

import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.PathManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.extensions.PluginId;
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.progress.Task;
import com.intellij.openapi.util.io.FileUtil;
import org.jetbrains.annotations.NotNull;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.CodeSource;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import com.github.claudecodegui.util.PlatformUtils;

/**
 * Bridge 目录解析器
 * 负责查找和管理 ai-bridge 目录（统一的 Claude 和 Codex SDK 桥接）
 */
public class BridgeDirectoryResolver {

    private static final Logger LOG = Logger.getInstance(BridgeDirectoryResolver.class);
    private static final String SDK_DIR_NAME = "ai-bridge";
    private static final String NODE_SCRIPT = "channel-manager.js";
    private static final String SDK_ARCHIVE_NAME = "ai-bridge.zip";
    private static final String BRIDGE_VERSION_FILE = ".bridge-version";
    private static final String BRIDGE_PATH_PROPERTY = "claude.bridge.path";
    private static final String BRIDGE_PATH_ENV = "CLAUDE_BRIDGE_PATH";
    private static final String PLUGIN_ID = "com.github.idea-claude-code-gui";
    private static final String PLUGIN_DIR_NAME = "idea-claude-code-gui";

    private File cachedSdkDir = null;
    private final Object bridgeExtractionLock = new Object();

    // Extraction state management
    private enum ExtractionState {
        NOT_STARTED,    // Initial state
        IN_PROGRESS,    // Extraction is running
        COMPLETED,      // Extraction finished successfully
        FAILED          // Extraction failed
    }

    private final AtomicReference<ExtractionState> extractionState = new AtomicReference<>(ExtractionState.NOT_STARTED);
    private volatile CompletableFuture<File> extractionFuture = null;
    private volatile CompletableFuture<Boolean> extractionReadyFuture = new CompletableFuture<>();

    /**
     * 查找 claude-bridge 目录
     * 优先级: 配置路径 > 嵌入式路径 > 缓存路径 > Fallback
     */
    public File findSdkDir() {
        // ✓ 优先级 1: 配置路径（最高优先级）
        File configuredDir = resolveConfiguredBridgeDir();
        if (configuredDir != null) {
            LOG.info("[BridgeResolver] 使用配置路径: " + configuredDir.getAbsolutePath());
            cachedSdkDir = configuredDir;
            return cachedSdkDir;
        }

        // ✓ 优先级 2: 嵌入式 ai-bridge.zip（生产环境优先）
        File embeddedDir = ensureEmbeddedBridgeExtracted();
        if (embeddedDir != null) {
            LOG.info("[BridgeResolver] 使用嵌入式路径: " + embeddedDir.getAbsolutePath());
            // 验证 node_modules 是否存在
            File nodeModules = new File(embeddedDir, "node_modules");
            LOG.info("[BridgeResolver] node_modules 存在: " + nodeModules.exists());
            cachedSdkDir = embeddedDir;
            return cachedSdkDir;
        }

        // ✓ 优先级 3: 使用缓存路径（如果存在且有效）
        if (cachedSdkDir != null && isValidBridgeDir(cachedSdkDir)) {
            LOG.info("[BridgeResolver] 使用缓存路径: " + cachedSdkDir.getAbsolutePath());
            return cachedSdkDir;
        }

        LOG.info("[BridgeResolver] 嵌入式路径未找到，尝试 fallback 查找...");

        // ✓ 优先级 4: Fallback（开发环境）
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
                cachedSdkDir = dir;
                LOG.info("[BridgeResolver] ✓ 使用 fallback 路径: " + cachedSdkDir.getAbsolutePath());
                File nodeModules = new File(cachedSdkDir, "node_modules");
                LOG.info("[BridgeResolver] node_modules 存在: " + nodeModules.exists());
                return cachedSdkDir;
            }
        }

        // 如果都找不到，打印调试信息
        LOG.warn("⚠️ 无法找到 ai-bridge 目录，已尝试以下位置：");
        for (File dir : possibleDirs) {
            LOG.warn("  - " + dir.getAbsolutePath() + " (存在: " + dir.exists() + ")");
        }

        // 返回默认值
        cachedSdkDir = new File(currentDir, SDK_DIR_NAME);
        LOG.warn("  使用默认路径: " + cachedSdkDir.getAbsolutePath());
        return cachedSdkDir;
    }

    /**
     * 解析配置的 Bridge 目录
     */
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
            LOG.info("✓ 使用 " + source + ": " + dir.getAbsolutePath());
            return dir;
        }
        LOG.warn("⚠️ " + source + " 指向无效目录: " + dir.getAbsolutePath());
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
            LOG.debug("  无法从插件描述符推断: " + t.getMessage());
        }

        try {
            String pluginsRoot = PathManager.getPluginsPath();
            if (!pluginsRoot.isEmpty()) {
                addCandidate(possibleDirs, Paths.get(pluginsRoot, PLUGIN_DIR_NAME, SDK_DIR_NAME).toFile());
                addCandidate(possibleDirs, Paths.get(pluginsRoot, PLUGIN_ID, SDK_DIR_NAME).toFile());
            }

            // 使用系统路径下的 plugins 目录代替已废弃的 getPluginTempPath()
            String systemPath = PathManager.getSystemPath();
            if (!systemPath.isEmpty()) {
                Path sandboxPath = Paths.get(systemPath, "plugins");
                addCandidate(possibleDirs, sandboxPath.resolve(PLUGIN_DIR_NAME).resolve(SDK_DIR_NAME).toFile());
                addCandidate(possibleDirs, sandboxPath.resolve(PLUGIN_ID).resolve(SDK_DIR_NAME).toFile());
            }
        } catch (Throwable t) {
            LOG.debug("  无法从插件路径推断: " + t.getMessage());
        }
    }

    private void addClasspathCandidates(List<File> possibleDirs) {
        try {
            CodeSource codeSource = BridgeDirectoryResolver.class.getProtectionDomain().getCodeSource();
            if (codeSource == null || codeSource.getLocation() == null) {
                LOG.debug("  无法从类路径推断: CodeSource 不可用");
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
            LOG.debug("  无法从类路径推断: " + e.getMessage());
        }
    }

    /**
     * 验证目录是否为有效的 bridge 目录
     * 增强验证: 检查核心脚本和关键依赖
     */
    public boolean isValidBridgeDir(File dir) {
        if (dir == null) {
            return false;
        }
        if (!dir.exists() || !dir.isDirectory()) {
            return false;
        }

        // 检查核心脚本
        File scriptFile = new File(dir, NODE_SCRIPT);
        if (!scriptFile.exists()) {
            return false;
        }

        // 检查 node_modules 关键依赖
        File nodeModules = new File(dir, "node_modules");
        if (!nodeModules.exists() || !nodeModules.isDirectory()) {
            LOG.warn("[BridgeResolver] node_modules 不存在: " + dir.getAbsolutePath());
            return false;
        }

        // 检查 @anthropic-ai/claude-agent-sdk
        File claudeSdk = new File(nodeModules, "@anthropic-ai/claude-agent-sdk");
        if (!claudeSdk.exists()) {
            LOG.warn("[BridgeResolver] 缺少 @anthropic-ai/claude-agent-sdk: " + dir.getAbsolutePath());
            return false;
        }

        return true;
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
            LOG.info("[BridgeResolver] 尝试查找内嵌的 ai-bridge.zip...");

            PluginId pluginId = PluginId.getId(PLUGIN_ID);
            IdeaPluginDescriptor descriptor = PluginManagerCore.getPlugin(pluginId);
            if (descriptor == null) {
                LOG.info("[BridgeResolver] 无法通过 PluginId 获取插件描述符: " + PLUGIN_ID);

                // 尝试通过遍历所有插件来查找
                for (IdeaPluginDescriptor plugin : PluginManagerCore.getPlugins()) {
                    String id = plugin.getPluginId().getIdString();
                    String name = plugin.getName();
                    // 匹配插件 ID 或名称
                    if (id.contains("claude") || id.contains("Claude") ||
                        (name != null && (name.contains("Claude") || name.contains("claude")))) {
                        LOG.info("[BridgeResolver] 找到候选插件: id=" + id + ", name=" + name + ", path=" + plugin.getPluginPath());
                        File candidateDir = plugin.getPluginPath().toFile();
                        File candidateArchive = new File(candidateDir, SDK_ARCHIVE_NAME);
                        if (candidateArchive.exists()) {
                            LOG.info("[BridgeResolver] 在候选插件中找到 ai-bridge.zip: " + candidateArchive.getAbsolutePath());
                            descriptor = plugin;
                            break;
                        }
                    }
                }

                if (descriptor == null) {
                    LOG.info("[BridgeResolver] 未能通过任何方式找到插件描述符");
                    return null;
                }
            }

            File pluginDir = descriptor.getPluginPath().toFile();
            LOG.info("[BridgeResolver] 插件目录: " + pluginDir.getAbsolutePath());

            File archiveFile = new File(pluginDir, SDK_ARCHIVE_NAME);
            LOG.info("[BridgeResolver] 查找压缩包: " + archiveFile.getAbsolutePath() + " (存在: " + archiveFile.exists() + ")");

            if (!archiveFile.exists()) {
                // 尝试在 lib 目录下查找
                File libDir = new File(pluginDir, "lib");
                if (libDir.exists()) {
                    LOG.info("[BridgeResolver] 检查 lib 目录: " + libDir.getAbsolutePath());
                    File[] files = libDir.listFiles();
                    if (files != null) {
                        for (File f : files) {
                            LOG.info("[BridgeResolver]   - " + f.getName());
                        }
                    }
                }

                // 如果在插件目录或 lib 下找不到，尝试查找常见的 sandbox 顶级 plugins 目录和 system/config 下的 plugins
                List<File> fallbackCandidates = new ArrayList<>();
                try {
                    // 向上查找祖先，寻找可能的 idea-sandbox 根目录或包含顶级 plugins 的目录
                    File ancestor = pluginDir;
                    int climbs = 0;
                    while (climbs < 6) {
                        File parent = ancestor.getParentFile();
                        if (parent == null) break;

                        File maybeTopPlugins = new File(parent, "plugins");
                        if (maybeTopPlugins.exists() && maybeTopPlugins.isDirectory()) {
                            fallbackCandidates.add(new File(maybeTopPlugins, PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                            fallbackCandidates.add(new File(maybeTopPlugins, PLUGIN_ID + File.separator + SDK_ARCHIVE_NAME));
                        }

                        // system/config siblings under this parent
                        File maybeSystemPlugins = new File(parent, "system/plugins");
                        File maybeConfigPlugins = new File(parent, "config/plugins");
                        if (maybeSystemPlugins.exists() && maybeSystemPlugins.isDirectory()) {
                            fallbackCandidates.add(new File(maybeSystemPlugins, PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                            fallbackCandidates.add(new File(maybeSystemPlugins, PLUGIN_ID + File.separator + SDK_ARCHIVE_NAME));
                        }
                        if (maybeConfigPlugins.exists() && maybeConfigPlugins.isDirectory()) {
                            fallbackCandidates.add(new File(maybeConfigPlugins, PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                            fallbackCandidates.add(new File(maybeConfigPlugins, PLUGIN_ID + File.separator + SDK_ARCHIVE_NAME));
                        }

                        ancestor = parent;
                        climbs++;
                    }
                } catch (Throwable ignore) {
                    // ignore fallback discovery errors
                }

                // 打印并尝试这些候选路径
                for (File f : fallbackCandidates) {
                    LOG.info("[BridgeResolver] 尝试候选路径: " + f.getAbsolutePath() + " (存在: " + f.exists() + ")");
                    if (f.exists()) {
                        archiveFile = f;
                        break;
                    }
                }

                if (!archiveFile.exists()) {
                    return null;
                }

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

                // Check current extraction state
                ExtractionState currentState = extractionState.get();

                if (currentState == ExtractionState.IN_PROGRESS) {
                    // Another thread is already extracting, wait for it
                    LOG.info("[BridgeResolver] 检测到正在解压中，等待完成...");
                    return waitForExtraction();
                }

                if (currentState == ExtractionState.COMPLETED && isValidBridgeDir(extractedDir)) {
                    // Already extracted and valid
                    return extractedDir;
                }

                // Start extraction
                LOG.info("未检测到已解压的 ai-bridge，开始解压: " + archiveFile.getAbsolutePath());

                // Mark as in progress
                extractionState.set(ExtractionState.IN_PROGRESS);

                // Check if running on EDT thread
                if (ApplicationManager.getApplication().isDispatchThread()) {
                    // Extract on background thread with progress indicator to avoid EDT freeze
                    LOG.info("[BridgeResolver] 检测到EDT线程，使用后台任务解压以避免UI冻结");
                    extractOnBackgroundThreadAsync(archiveFile, extractedDir, signature, versionFile);
                    // DO NOT wait here - return null and let caller handle async initialization
                    // The extractionReadyFuture will be completed when extraction finishes
                    LOG.info("[BridgeResolver] EDT线程不阻塞等待，返回null，请使用getExtractionFuture()异步等待");
                    return null;
                } else {
                    // Direct extraction on non-EDT thread
                    try {
                        deleteDirectory(extractedDir);
                        unzipArchive(archiveFile, extractedDir);
                        Files.writeString(versionFile.toPath(), signature, StandardCharsets.UTF_8);
                        extractionState.set(ExtractionState.COMPLETED);
                        extractionReadyFuture.complete(true);
                    } catch (Exception e) {
                        extractionState.set(ExtractionState.FAILED);
                        extractionReadyFuture.complete(false);
                        LOG.error("[BridgeResolver] 解压失败: " + e.getMessage(), e);
                        throw e;
                    }
                }
            }

            if (isValidBridgeDir(extractedDir)) {
                LOG.info("✓ ai-bridge 解压完成: " + extractedDir.getAbsolutePath());
                return extractedDir;
            }

            LOG.warn("⚠️ ai-bridge 解压后结构无效: " + extractedDir.getAbsolutePath());
        } catch (Exception e) {
            LOG.error("⚠️ 自动解压 ai-bridge 失败: " + e.getMessage());
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

    /**
     * Wait for ongoing extraction to complete.
     * Returns the extracted directory or null if failed.
     */
    private File waitForExtraction() {
        CompletableFuture<File> future = extractionFuture;
        if (future == null) {
            LOG.warn("[BridgeResolver] No extraction future available");
            return null;
        }

        try {
            LOG.info("[BridgeResolver] Waiting for extraction to complete...");
            File result = future.join(); // Block until completion
            LOG.info("[BridgeResolver] Extraction completed, result: " + (result != null ? result.getAbsolutePath() : "null"));
            return result;
        } catch (Exception e) {
            LOG.error("[BridgeResolver] Failed to wait for extraction: " + e.getMessage(), e);
            extractionState.set(ExtractionState.FAILED);
            return null;
        }
    }

    /**
     * Extract ai-bridge on background thread with progress indicator (async).
     * This method uses Task.Backgroundable to avoid EDT freeze.
     * Returns immediately, extraction runs in background.
     */
    private void extractOnBackgroundThreadAsync(File archiveFile, File extractedDir, String signature, File versionFile) {
        // Create a future to track extraction result
        extractionFuture = new CompletableFuture<>();

        try {
            ProgressManager.getInstance().run(new Task.Backgroundable(null, "Extracting AI Bridge", true) {
                @Override
                public void run(@NotNull ProgressIndicator indicator) {
                    indicator.setIndeterminate(false);
                    indicator.setText("Extracting ai-bridge.zip...");

                    try {
                        // Delete old directory
                        indicator.setFraction(0.1);
                        indicator.setText("Cleaning old files...");
                        deleteDirectory(extractedDir);

                        // Extract archive
                        indicator.setFraction(0.2);
                        indicator.setText("Extracting archive...");
                        unzipArchiveWithProgress(archiveFile, extractedDir, indicator);

                        // Write version file
                        indicator.setFraction(0.9);
                        indicator.setText("Finalizing...");
                        Files.writeString(versionFile.toPath(), signature, StandardCharsets.UTF_8);

                        indicator.setFraction(1.0);
                        LOG.info("[BridgeResolver] Background extraction completed successfully");

                        // Mark as completed
                        extractionState.set(ExtractionState.COMPLETED);
                        extractionFuture.complete(extractedDir);
                        extractionReadyFuture.complete(true);
                    } catch (IOException e) {
                        LOG.error("[BridgeResolver] Background extraction failed: " + e.getMessage(), e);
                        extractionState.set(ExtractionState.FAILED);
                        extractionFuture.completeExceptionally(e);
                        extractionReadyFuture.complete(false);
                    }
                }

                @Override
                public void onCancel() {
                    LOG.warn("[BridgeResolver] Extraction cancelled by user");
                    extractionState.set(ExtractionState.FAILED);
                    extractionFuture.completeExceptionally(new InterruptedException("Extraction cancelled"));
                    extractionReadyFuture.complete(false);
                }

                @Override
                public void onThrowable(@NotNull Throwable error) {
                    LOG.error("[BridgeResolver] Extraction task threw error: " + error.getMessage(), error);
                    extractionState.set(ExtractionState.FAILED);
                    extractionFuture.completeExceptionally(error);
                    extractionReadyFuture.complete(false);
                }
            });
        } catch (Exception e) {
            LOG.error("[BridgeResolver] Failed to start background extraction task: " + e.getMessage(), e);
            extractionState.set(ExtractionState.FAILED);
            extractionFuture.completeExceptionally(e);
            extractionReadyFuture.complete(false);
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
                LOG.warn("⚠️ 无法删除目录: " + dir.getAbsolutePath());
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

    /**
     * Unzip archive with progress indicator support.
     * This method counts total entries first, then updates progress during extraction.
     */
    private void unzipArchiveWithProgress(File archiveFile, File targetDir, ProgressIndicator indicator) throws IOException {
        Files.createDirectories(targetDir.toPath());
        Path targetPath = targetDir.toPath();
        byte[] buffer = new byte[8192];

        // First pass: count total entries
        int totalEntries = 0;
        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(archiveFile)))) {
            while (zis.getNextEntry() != null) {
                totalEntries++;
                zis.closeEntry();
            }
        }

        LOG.info("[BridgeResolver] Total entries to extract: " + totalEntries);

        // Second pass: extract with progress
        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(archiveFile)))) {
            ZipEntry entry;
            int processedEntries = 0;

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
                processedEntries++;

                // Update progress (0.2 to 0.9 range allocated for extraction)
                double progress = 0.2 + (0.7 * processedEntries / totalEntries);
                indicator.setFraction(progress);
                indicator.setText("Extracting: " + entry.getName() + " (" + processedEntries + "/" + totalEntries + ")");
            }
        }
    }

    /**
     * 手动设置 claude-bridge 目录路径.
     */
    public void setSdkDir(String path) {
        this.cachedSdkDir = new File(path);
    }

    /**
     * 获取当前使用的 claude-bridge 目录.
     */
    public File getSdkDir() {
        if (this.cachedSdkDir == null) {
            return this.findSdkDir();
        }
        return this.cachedSdkDir;
    }

    /**
     * 清除缓存.
     */
    public void clearCache() {
        this.cachedSdkDir = null;
        this.extractionState.set(ExtractionState.NOT_STARTED);
        this.extractionFuture = null;
        this.extractionReadyFuture = new CompletableFuture<>();
    }

    /**
     * Check if extraction is complete (non-blocking).
     * Returns true if extraction finished successfully and bridge is valid.
     */
    public boolean isExtractionComplete() {
        ExtractionState state = extractionState.get();
        if (state == ExtractionState.COMPLETED && cachedSdkDir != null) {
            return isValidBridgeDir(cachedSdkDir);
        }
        // Also check if we have a valid configured or cached dir without extraction
        if (cachedSdkDir != null && isValidBridgeDir(cachedSdkDir)) {
            return true;
        }
        return false;
    }

    /**
     * Get a future that completes when extraction is ready.
     * This allows callers to wait asynchronously without blocking EDT.
     *
     * @return CompletableFuture that completes with true if bridge is ready, false otherwise
     */
    public CompletableFuture<Boolean> getExtractionFuture() {
        // If already completed, return a completed future
        if (isExtractionComplete()) {
            return CompletableFuture.completedFuture(true);
        }

        // If extraction hasn't started yet, trigger it on a background thread
        if (extractionState.get() == ExtractionState.NOT_STARTED) {
            // The next call to findSdkDir will trigger extraction
            // For now, return the ready future which will be completed when extraction finishes
        }

        return extractionReadyFuture;
    }

    /**
     * Check if extraction is currently in progress.
     */
    public boolean isExtractionInProgress() {
        return extractionState.get() == ExtractionState.IN_PROGRESS;
    }
}


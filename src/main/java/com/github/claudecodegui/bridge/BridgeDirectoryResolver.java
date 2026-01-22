package com.github.claudecodegui.bridge;

import com.github.claudecodegui.util.PlatformUtils;
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
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Bridge 目录解析器
 * 负责查找和管理 ai-bridge 目录（统一的 Claude 和 Codex SDK 桥接）
 */
public class BridgeDirectoryResolver {

    private static final Logger LOG = Logger.getInstance(BridgeDirectoryResolver.class);
    private static final String SDK_DIR_NAME = "ai-bridge";
    private static final String NODE_SCRIPT = "channel-manager.js";
    private static final String SDK_ARCHIVE_NAME = "ai-bridge.zip";
    private static final String SDK_HASH_FILE_NAME = "ai-bridge.hash";
    private static final String BRIDGE_VERSION_FILE = ".bridge-version";
    private static final String BRIDGE_PATH_PROPERTY = "claude.bridge.path";
    private static final String BRIDGE_PATH_ENV = "CLAUDE_BRIDGE_PATH";
    private static final String PLUGIN_DIR_NAME = "idea-claude-code-gui";

    private volatile File cachedSdkDir = null;
    /**
     * 通过 setSdkDir() 手动设置的目录路径，具有最高优先级。
     * 与 cachedSdkDir 的区别：
     * - manuallySdkDir: 用户显式调用 setSdkDir() 设置，不会被自动发现逻辑覆盖
     * - cachedSdkDir: 通过任何途径（手动或自动）找到的目录缓存
     */
    private volatile File manuallySdkDir = null;
    private final Object bridgeExtractionLock = new Object();

    // Extraction state management
    private enum ExtractionState {
        NOT_STARTED,    // Initial state
        IN_PROGRESS,    // Extraction is running
        COMPLETED,      // Extraction finished successfully
        FAILED          // Extraction failed
    }

    private final AtomicReference<ExtractionState> extractionState = new AtomicReference<>(ExtractionState.NOT_STARTED);
    private final AtomicReference<CompletableFuture<File>> extractionFutureRef = new AtomicReference<>();
    private volatile CompletableFuture<Boolean> extractionReadyFuture = new CompletableFuture<>();

    /**
     * 查找 claude-bridge 目录
     * 优先级: 手动设置路径 > 配置路径 > 嵌入式路径 > 缓存路径 > Fallback
     */
    public File findSdkDir() {
        // ✓ 优先级 0: 手动设置路径（通过 setSdkDir() 调用，最高优先级）
        if (this.manuallySdkDir != null && isValidBridgeDir(this.manuallySdkDir)) {
            LOG.debug("[BridgeResolver] Using manually set path: " + this.manuallySdkDir.getAbsolutePath());
            this.cachedSdkDir = this.manuallySdkDir;
            return this.cachedSdkDir;
        }

        // ✓ 优先级 1: 配置路径
        File configuredDir = resolveConfiguredBridgeDir();
        if (configuredDir != null) {
            LOG.debug("[BridgeResolver] Using configured path: " + configuredDir.getAbsolutePath());
            this.cachedSdkDir = configuredDir;
            return this.cachedSdkDir;
        }

        // ✓ 检查是否正在解压中（避免重复触发解压）
        if (this.extractionState.get() == ExtractionState.IN_PROGRESS) {
            LOG.debug("[BridgeResolver] Extraction in progress, returning null");
            return null;
        }

        // ✓ 优先级 2: 嵌入式 ai-bridge.zip（生产环境优先）
        File embeddedDir = ensureEmbeddedBridgeExtracted();
        if (embeddedDir != null) {
            LOG.info("[BridgeResolver] Using embedded path: " + embeddedDir.getAbsolutePath());
            // 验证 node_modules 是否存在
            File nodeModules = new File(embeddedDir, "node_modules");
            LOG.debug("[BridgeResolver] node_modules exists: " + nodeModules.exists());
            this.cachedSdkDir = embeddedDir;
            return this.cachedSdkDir;
        }

        // ✓ 再次检查：如果 ensureEmbeddedBridgeExtracted() 触发了后台解压（EDT线程场景）
        // 此时状态会变成 IN_PROGRESS，我们应该返回 null 而不是使用 fallback 路径
        if (this.extractionState.get() == ExtractionState.IN_PROGRESS) {
            LOG.debug("[BridgeResolver] Background extraction started, returning null to avoid incorrect fallback path");
            return null;
        }

        // ✓ 优先级 3: 使用缓存路径（如果存在且有效）
        if (this.cachedSdkDir != null && isValidBridgeDir(this.cachedSdkDir)) {
            LOG.debug("[BridgeResolver] Using cached path: " + this.cachedSdkDir.getAbsolutePath());
            return this.cachedSdkDir;
        }

        LOG.debug("[BridgeResolver] Embedded path not found, trying fallback search...");

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
                this.cachedSdkDir = dir;
                LOG.info("[BridgeResolver] Using fallback path: " + this.cachedSdkDir.getAbsolutePath());
                File nodeModules = new File(this.cachedSdkDir, "node_modules");
                LOG.debug("[BridgeResolver] node_modules exists: " + nodeModules.exists());
                return this.cachedSdkDir;
            }
        }

        // 如果都找不到，打印调试信息
        LOG.warn("[BridgeResolver] Cannot find ai-bridge directory, tried locations:");
        for (File dir : possibleDirs) {
            LOG.warn("  - " + dir.getAbsolutePath() + " (exists: " + dir.exists() + ")");
        }

        // 返回默认值
        this.cachedSdkDir = new File(currentDir, SDK_DIR_NAME);
        LOG.warn("[BridgeResolver] Using default path: " + this.cachedSdkDir.getAbsolutePath());
        return this.cachedSdkDir;
    }

    /**
     * 解析配置的 Bridge 目录
     */
    private File resolveConfiguredBridgeDir() {
        File fromProperty = tryResolveConfiguredPath(
            System.getProperty(BRIDGE_PATH_PROPERTY),
            "system property " + BRIDGE_PATH_PROPERTY
        );
        if (fromProperty != null) {
            return fromProperty;
        }
        return tryResolveConfiguredPath(
            System.getenv(BRIDGE_PATH_ENV),
            "environment variable " + BRIDGE_PATH_ENV
        );
    }

    private File tryResolveConfiguredPath(String path, String source) {
        if (path == null || path.trim().isEmpty()) {
            return null;
        }
        File dir = new File(path.trim());
        if (isValidBridgeDir(dir)) {
            LOG.debug("[BridgeResolver] Using " + source + ": " + dir.getAbsolutePath());
            return dir;
        }
        LOG.warn("[BridgeResolver] " + source + " points to invalid directory: " + dir.getAbsolutePath());
        return null;
    }

    private void addPluginCandidates(List<File> possibleDirs) {
        try {
            PluginId pluginId = PluginId.getId(PlatformUtils.getPluginId());
            IdeaPluginDescriptor descriptor = PluginManagerCore.getPlugin(pluginId);
            if (descriptor != null) {
                File pluginDir = descriptor.getPluginPath().toFile();
                addCandidate(possibleDirs, new File(pluginDir, SDK_DIR_NAME));
            }
        } catch (Throwable t) {
            LOG.debug("[BridgeResolver] Cannot infer from plugin descriptor: " + t.getMessage());
        }

        try {
            String pluginsRoot = PathManager.getPluginsPath();
            if (!pluginsRoot.isEmpty()) {
                addCandidate(possibleDirs, Paths.get(pluginsRoot, PLUGIN_DIR_NAME, SDK_DIR_NAME).toFile());
                addCandidate(possibleDirs, Paths.get(pluginsRoot, PlatformUtils.getPluginId(), SDK_DIR_NAME).toFile());
            }

            String systemPath = PathManager.getSystemPath();
            if (!systemPath.isEmpty()) {
                Path sandboxPath = Paths.get(systemPath, "plugins");
                addCandidate(possibleDirs, sandboxPath.resolve(PLUGIN_DIR_NAME).resolve(SDK_DIR_NAME).toFile());
                addCandidate(possibleDirs, sandboxPath.resolve(PlatformUtils.getPluginId()).resolve(SDK_DIR_NAME).toFile());
            }
        } catch (Throwable t) {
            LOG.debug("[BridgeResolver] Cannot infer from plugin path: " + t.getMessage());
        }
    }

    private void addClasspathCandidates(List<File> possibleDirs) {
        try {
            CodeSource codeSource = BridgeDirectoryResolver.class.getProtectionDomain().getCodeSource();
            if (codeSource == null || codeSource.getLocation() == null) {
                LOG.debug("[BridgeResolver] Cannot infer from classpath: CodeSource unavailable");
                return;
            }
            File location = new File(codeSource.getLocation().toURI());
            File classDir = location.getParentFile();
            while (classDir != null && classDir.exists()) {
                addCandidate(possibleDirs, new File(classDir, SDK_DIR_NAME));
                String name = classDir.getName();
                if (PLUGIN_DIR_NAME.equals(name) || PlatformUtils.getPluginId().equals(name)) {
                    break;
                }
                if (isRootDirectory(classDir)) {
                    break;
                }
                classDir = classDir.getParentFile();
            }
        } catch (Exception e) {
            LOG.debug("[BridgeResolver] Cannot infer from classpath: " + e.getMessage());
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
            LOG.debug("[BridgeResolver] node_modules not found: " + dir.getAbsolutePath());
            return false;
        }

        // 检查 @anthropic-ai/claude-agent-sdk
        File claudeSdk = new File(nodeModules, "@anthropic-ai/claude-agent-sdk");
        if (!claudeSdk.exists()) {
            LOG.debug("[BridgeResolver] Missing @anthropic-ai/claude-agent-sdk: " + dir.getAbsolutePath());
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
            LOG.debug("[BridgeResolver] Looking for embedded ai-bridge.zip...");

            PluginId pluginId = PluginId.getId(PlatformUtils.getPluginId());
            IdeaPluginDescriptor descriptor = PluginManagerCore.getPlugin(pluginId);
            if (descriptor == null) {
                LOG.debug("[BridgeResolver] Cannot get plugin descriptor by PluginId: " + PlatformUtils.getPluginId());

                // 尝试通过遍历所有插件来查找
                for (IdeaPluginDescriptor plugin : PluginManagerCore.getPlugins()) {
                    String id = plugin.getPluginId().getIdString();
                    String name = plugin.getName();
                    // 匹配插件 ID 或名称
                    if (id.contains("claude") || id.contains("Claude") ||
                        (name != null && (name.contains("Claude") || name.contains("claude")))) {
                        LOG.debug("[BridgeResolver] Found candidate plugin: id=" + id + ", name=" + name + ", path=" + plugin.getPluginPath());
                        File candidateDir = plugin.getPluginPath().toFile();
                        File candidateArchive = new File(candidateDir, SDK_ARCHIVE_NAME);
                        if (candidateArchive.exists()) {
                            LOG.debug("[BridgeResolver] Found ai-bridge.zip in candidate plugin: " + candidateArchive.getAbsolutePath());
                            descriptor = plugin;
                            break;
                        }
                    }
                }

                if (descriptor == null) {
                    LOG.debug("[BridgeResolver] Could not find plugin descriptor by any method");
                    return null;
                }
            }

            File pluginDir = descriptor.getPluginPath().toFile();
            LOG.debug("[BridgeResolver] Plugin directory: " + pluginDir.getAbsolutePath());

            File archiveFile = new File(pluginDir, SDK_ARCHIVE_NAME);
            LOG.debug("[BridgeResolver] Looking for archive: " + archiveFile.getAbsolutePath() + " (exists: " + archiveFile.exists() + ")");

            if (!archiveFile.exists()) {
                // 尝试在 lib 目录下查找
                File libDir = new File(pluginDir, "lib");
                if (libDir.exists()) {
                    LOG.debug("[BridgeResolver] Checking lib directory: " + libDir.getAbsolutePath());
                    File[] files = libDir.listFiles();
                    if (files != null) {
                        for (File f : files) {
                            LOG.debug("[BridgeResolver]   - " + f.getName());
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
                            fallbackCandidates.add(new File(maybeTopPlugins, PlatformUtils.getPluginId() + File.separator + SDK_ARCHIVE_NAME));
                        }

                        // system/config siblings under this parent
                        File maybeSystemPlugins = new File(parent, "system/plugins");
                        File maybeConfigPlugins = new File(parent, "config/plugins");
                        if (maybeSystemPlugins.exists() && maybeSystemPlugins.isDirectory()) {
                            fallbackCandidates.add(new File(maybeSystemPlugins, PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                            fallbackCandidates.add(new File(maybeSystemPlugins, PlatformUtils.getPluginId() + File.separator + SDK_ARCHIVE_NAME));
                        }
                        if (maybeConfigPlugins.exists() && maybeConfigPlugins.isDirectory()) {
                            fallbackCandidates.add(new File(maybeConfigPlugins, PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                            fallbackCandidates.add(new File(maybeConfigPlugins, PlatformUtils.getPluginId() + File.separator + SDK_ARCHIVE_NAME));
                        }

                        ancestor = parent;
                        climbs++;
                    }
                } catch (Throwable ignore) {
                    // ignore fallback discovery errors
                }

                // 打印并尝试这些候选路径
                for (File f : fallbackCandidates) {
                    LOG.debug("[BridgeResolver] Trying candidate path: " + f.getAbsolutePath() + " (exists: " + f.exists() + ")");
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
            // Prefer precomputed hash file (generated at build time) to avoid runtime calculation overhead
            // Note: hash file should be in the same directory as archiveFile
            File archiveParentDir = archiveFile.getParentFile();
            String archiveHash = readPrecomputedHash(archiveParentDir);
            if (archiveHash == null) {
                LOG.info("[BridgeResolver] Precomputed hash file not found, falling back to runtime calculation");
                archiveHash = calculateFileHash(archiveFile);
            }
            if (archiveHash == null) {
                LOG.warn("[BridgeResolver] Failed to calculate archive hash, falling back to version-based signature");
                archiveHash = "unknown";
            }
            String signature = descriptor.getVersion() + ":" + archiveHash;
            File versionFile = new File(extractedDir, BRIDGE_VERSION_FILE);

            if (isValidBridgeDir(extractedDir) && bridgeSignatureMatches(versionFile, signature)) {
                this.cachedSdkDir = extractedDir;
                return extractedDir;
            }

            synchronized (this.bridgeExtractionLock) {
                if (isValidBridgeDir(extractedDir) && bridgeSignatureMatches(versionFile, signature)) {
                    this.cachedSdkDir = extractedDir;
                    return extractedDir;
                }

                // Check current extraction state
                ExtractionState currentState = this.extractionState.get();

                if (currentState == ExtractionState.IN_PROGRESS) {
                    // Another thread is already extracting, wait for it
                    LOG.debug("[BridgeResolver] Extraction in progress, waiting for completion...");
                    return waitForExtraction();
                }

                if (currentState == ExtractionState.COMPLETED && isValidBridgeDir(extractedDir)) {
                    // Already extracted and valid
                    this.cachedSdkDir = extractedDir;
                    return extractedDir;
                }

                // Start extraction
                LOG.info("[BridgeResolver] No extracted ai-bridge found, starting extraction: " + archiveFile.getAbsolutePath());

                // Mark as in progress BEFORE checking EDT thread
                // Also initialize extractionFutureRef to ensure waitForExtraction() works
                if (!this.extractionState.compareAndSet(ExtractionState.NOT_STARTED, ExtractionState.IN_PROGRESS) &&
                    !this.extractionState.compareAndSet(ExtractionState.FAILED, ExtractionState.IN_PROGRESS)) {
                    // Another thread just started extraction, wait for it
                    LOG.debug("[BridgeResolver] Another thread just started extraction, waiting...");
                    return waitForExtraction();
                }

                // Initialize extractionFutureRef for non-EDT threads to wait on
                CompletableFuture<File> currentFuture = this.extractionFutureRef.get();
                if (currentFuture == null || currentFuture.isDone()) {
                    CompletableFuture<File> newFuture = new CompletableFuture<>();
                    this.extractionFutureRef.compareAndSet(currentFuture, newFuture);
                }

                // Check if running on EDT thread
                if (ApplicationManager.getApplication().isDispatchThread()) {
                    // Extract on background thread with progress indicator to avoid EDT freeze
                    LOG.debug("[BridgeResolver] EDT thread detected, using background task to avoid UI freeze");
                    extractOnBackgroundThreadAsync(archiveFile, extractedDir, signature, versionFile);
                    // DO NOT wait here - return null and let caller handle async initialization
                    // The extractionReadyFuture will be completed when extraction finishes
                    LOG.debug("[BridgeResolver] EDT thread not blocking, returning null. Use getExtractionFuture() to wait asynchronously");
                    return null;
                } else {
                    // Direct extraction on non-EDT thread
                    try {
                        deleteDirectory(extractedDir);
                        unzipArchive(archiveFile, extractedDir);
                        Files.writeString(versionFile.toPath(), signature, StandardCharsets.UTF_8);
                        this.extractionState.set(ExtractionState.COMPLETED);
                        this.cachedSdkDir = extractedDir;
                        CompletableFuture<File> future = this.extractionFutureRef.get();
                        if (future != null) {
                            future.complete(extractedDir);
                        }
                        this.extractionReadyFuture.complete(true);
                    } catch (Exception e) {
                        this.extractionState.set(ExtractionState.FAILED);
                        CompletableFuture<File> future = this.extractionFutureRef.get();
                        if (future != null) {
                            future.completeExceptionally(e);
                        }
                        this.extractionReadyFuture.complete(false);
                        LOG.error("[BridgeResolver] Extraction failed: " + e.getMessage(), e);
                        throw e;
                    }
                }
            }

            if (isValidBridgeDir(extractedDir)) {
                LOG.info("[BridgeResolver] ai-bridge extraction completed: " + extractedDir.getAbsolutePath());
                return extractedDir;
            }

            LOG.warn("[BridgeResolver] ai-bridge structure invalid after extraction: " + extractedDir.getAbsolutePath());
        } catch (Exception e) {
            LOG.error("[BridgeResolver] Auto-extraction of ai-bridge failed: " + e.getMessage());
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
        CompletableFuture<File> future = this.extractionFutureRef.get();
        if (future == null) {
            LOG.warn("[BridgeResolver] No extraction future available");
            return null;
        }

        try {
            LOG.info("[BridgeResolver] Waiting for extraction to complete...");
            File result = future.join(); // Block until completion
            LOG.info("[BridgeResolver] Extraction completed, result: " + (result != null ? result.getAbsolutePath() : "null"));
            if (result != null) {
                this.cachedSdkDir = result;
            }
            return result;
        } catch (Exception e) {
            LOG.error("[BridgeResolver] Failed to wait for extraction: " + e.getMessage(), e);
            this.extractionState.set(ExtractionState.FAILED);
            return null;
        }
    }

    /**
     * Extract ai-bridge on background thread with progress indicator (async).
     * This method uses Task.Backgroundable to avoid EDT freeze.
     * Returns immediately, extraction runs in background.
     * NOTE: extractionFutureRef should already be initialized by the caller.
     */
    private void extractOnBackgroundThreadAsync(File archiveFile, File extractedDir, String signature, File versionFile) {
        // extractionFutureRef should already be initialized by caller
        // Do NOT recreate it here to avoid race conditions

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

                        // Mark as completed and cache the directory
                        BridgeDirectoryResolver.this.extractionState.set(ExtractionState.COMPLETED);
                        BridgeDirectoryResolver.this.cachedSdkDir = extractedDir;
                        CompletableFuture<File> future = BridgeDirectoryResolver.this.extractionFutureRef.get();
                        if (future != null) {
                            future.complete(extractedDir);
                        }
                        BridgeDirectoryResolver.this.extractionReadyFuture.complete(true);
                    } catch (IOException e) {
                        LOG.error("[BridgeResolver] Background extraction failed: " + e.getMessage(), e);
                        BridgeDirectoryResolver.this.extractionState.set(ExtractionState.FAILED);
                        CompletableFuture<File> future = BridgeDirectoryResolver.this.extractionFutureRef.get();
                        if (future != null) {
                            future.completeExceptionally(e);
                        }
                        BridgeDirectoryResolver.this.extractionReadyFuture.complete(false);
                    }
                }

                @Override
                public void onCancel() {
                    LOG.warn("[BridgeResolver] Extraction cancelled by user");
                    BridgeDirectoryResolver.this.extractionState.set(ExtractionState.FAILED);
                    CompletableFuture<File> future = BridgeDirectoryResolver.this.extractionFutureRef.get();
                    if (future != null) {
                        future.completeExceptionally(new InterruptedException("Extraction cancelled"));
                    }
                    BridgeDirectoryResolver.this.extractionReadyFuture.complete(false);
                }

                @Override
                public void onThrowable(@NotNull Throwable error) {
                    LOG.error("[BridgeResolver] Extraction task threw error: " + error.getMessage(), error);
                    BridgeDirectoryResolver.this.extractionState.set(ExtractionState.FAILED);
                    CompletableFuture<File> future = BridgeDirectoryResolver.this.extractionFutureRef.get();
                    if (future != null) {
                        future.completeExceptionally(error);
                    }
                    BridgeDirectoryResolver.this.extractionReadyFuture.complete(false);
                }
            });
        } catch (Exception e) {
            LOG.error("[BridgeResolver] Failed to start background extraction task: " + e.getMessage(), e);
            this.extractionState.set(ExtractionState.FAILED);
            CompletableFuture<File> future = this.extractionFutureRef.get();
            if (future != null) {
                future.completeExceptionally(e);
            }
            this.extractionReadyFuture.complete(false);
        }
    }

    private void deleteDirectory(File dir) {
        if (dir == null || !dir.exists()) {
            return;
        }
        // Use retry mechanism for directory deletion to handle Windows file locking issues
        if (!PlatformUtils.deleteDirectoryWithRetry(dir, 3)) {
            // If retry fails, fall back to IntelliJ's FileUtil
            if (!FileUtil.delete(dir)) {
                LOG.warn("[BridgeResolver] Cannot delete directory: " + dir.getAbsolutePath());
            }
        }
    }

    private void unzipArchive(File archiveFile, File targetDir) throws IOException {
        Files.createDirectories(targetDir.toPath());

        // Try to use system unzip command to preserve permissions
        if (trySystemUnzip(archiveFile, targetDir)) {
            LOG.info("[BridgeResolver] Successfully extracted using system unzip command");
            return;
        }

        // Fallback to Java ZipInputStream
        LOG.warn("[BridgeResolver] System unzip not available, using Java ZipInputStream (permissions may be lost)");
        unzipWithJava(archiveFile, targetDir);
    }

    /**
     * Try to extract using system unzip command to preserve file permissions.
     * Returns true if successful, false if unzip command is not available.
     */
    private boolean trySystemUnzip(File archiveFile, File targetDir) {
        return executeSystemUnzip(archiveFile, targetDir, null);
    }

    /**
     * Try to extract using system unzip command with progress updates.
     */
    private boolean trySystemUnzipWithProgress(File archiveFile, File targetDir, ProgressIndicator indicator) {
        if (indicator != null) {
            indicator.setText("Extracting with system unzip...");
            indicator.setFraction(0.5);
        }
        boolean result = executeSystemUnzip(archiveFile, targetDir, indicator);
        if (result && indicator != null) {
            indicator.setFraction(0.9);
        }
        return result;
    }

    /**
     * Core implementation for system unzip extraction.
     * @param archiveFile The archive to extract
     * @param targetDir The target directory
     * @param indicator Optional progress indicator (can be null)
     * @return true if extraction succeeded, false otherwise
     */
    private boolean executeSystemUnzip(File archiveFile, File targetDir, ProgressIndicator indicator) {
        Process process = null;
        try {
            ProcessBuilder pb;
            if (System.getProperty("os.name").toLowerCase().contains("windows")) {
                // Windows: try to use tar command (available in Windows 10+)
                pb = new ProcessBuilder("tar", "-xf", archiveFile.getAbsolutePath(), "-C", targetDir.getAbsolutePath());
            } else {
                // Unix/Linux/macOS: use unzip command
                pb = new ProcessBuilder("unzip", "-o", "-q", archiveFile.getAbsolutePath(), "-d", targetDir.getAbsolutePath());
            }

            pb.redirectErrorStream(true);
            process = pb.start();

            // Read output to prevent blocking
            try (java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    LOG.debug("[BridgeResolver] unzip: " + line);
                }
            }

            // Add timeout (5 minutes) to prevent hanging
            if (!process.waitFor(5, java.util.concurrent.TimeUnit.MINUTES)) {
                LOG.warn("[BridgeResolver] Unzip process timeout, killing...");
                process.destroyForcibly();
                return false;
            }

            return process.exitValue() == 0;
        } catch (Exception e) {
            LOG.debug("[BridgeResolver] System unzip failed: " + e.getMessage());
            return false;
        } finally {
            // Ensure process is destroyed if still alive
            if (process != null && process.isAlive()) {
                LOG.warn("[BridgeResolver] Forcibly destroying unzip process");
                process.destroyForcibly();
            }
        }
    }

    /**
     * Fallback extraction using Java ZipInputStream.
     * Note: This method does not preserve Unix file permissions.
     */
    private void unzipWithJava(File archiveFile, File targetDir) throws IOException {
        Path targetPath = targetDir.toPath();
        byte[] buffer = new byte[8192];

        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(archiveFile)))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                Path resolvedPath = targetPath.resolve(entry.getName()).normalize();
                if (!resolvedPath.startsWith(targetPath)) {
                    throw new IOException("Unsafe zip entry detected: " + entry.getName());
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

        // Try to use system unzip command first
        if (trySystemUnzipWithProgress(archiveFile, targetDir, indicator)) {
            LOG.info("[BridgeResolver] Successfully extracted using system unzip command");
            return;
        }

        // Fallback to Java ZipInputStream
        LOG.warn("[BridgeResolver] System unzip not available, using Java ZipInputStream (permissions may be lost)");
        unzipWithJavaAndProgress(archiveFile, targetDir, indicator);
    }

    /**
     * Fallback extraction with progress using Java ZipInputStream.
     */
    private void unzipWithJavaAndProgress(File archiveFile, File targetDir, ProgressIndicator indicator) throws IOException {
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
                    throw new IOException("Unsafe zip entry detected: " + entry.getName());
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
     * 此方法设置的路径具有最高优先级，会覆盖配置路径和嵌入式路径。
     * 设置后，findSdkDir() 将优先返回此路径。
     *
     * @param path 目录路径
     */
    public void setSdkDir(String path) {
        this.manuallySdkDir = new File(path);
        this.cachedSdkDir = this.manuallySdkDir;
        LOG.debug("[BridgeResolver] Manually set SDK directory to: " + path);
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
     * 清除所有缓存，包括手动设置的路径和自动发现的缓存。
     * 调用后，下次 findSdkDir() 将重新执行完整的路径发现逻辑。
     */
    public void clearCache() {
        this.cachedSdkDir = null;
        this.manuallySdkDir = null;
        this.extractionState.set(ExtractionState.NOT_STARTED);
        this.extractionFutureRef.set(null);
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
        return this.extractionState.get() == ExtractionState.IN_PROGRESS;
    }

    /**
     * Read precomputed hash from ai-bridge.hash file (generated at build time).
     * This avoids expensive runtime hash calculation.
     *
     * @param pluginDir The plugin directory containing ai-bridge.hash
     * @return The hash string, or null if file doesn't exist or read fails
     */
    private String readPrecomputedHash(File pluginDir) {
        File hashFile = new File(pluginDir, SDK_HASH_FILE_NAME);
        if (!hashFile.exists()) {
            LOG.debug("[BridgeResolver] Precomputed hash file not found: " + hashFile.getAbsolutePath());
            return null;
        }

        try {
            String hash = Files.readString(hashFile.toPath(), StandardCharsets.UTF_8).trim();
            if (hash.isEmpty()) {
                LOG.warn("[BridgeResolver] Precomputed hash file is empty");
                return null;
            }
            LOG.debug("[BridgeResolver] Using precomputed hash: " + hash);
            return hash;
        } catch (IOException e) {
            LOG.warn("[BridgeResolver] Failed to read precomputed hash: " + e.getMessage());
            return null;
        }
    }

    /**
     * Calculate SHA-256 hash of a file.
     * NOTE: This is a fallback method only used when precomputed hash file is missing.
     * Prefer using readPrecomputedHash() when available.
     *
     * @param file The file to hash
     * @return Hex string of the hash, or null if calculation fails
     */
    private String calculateFileHash(File file) {
        if (file == null || !file.exists()) {
            return null;
        }

        LOG.info("[BridgeResolver] Calculating archive hash at runtime (fallback mode)");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[8192];

            try (FileInputStream fis = new FileInputStream(file);
                 BufferedInputStream bis = new BufferedInputStream(fis)) {
                int bytesRead;
                while ((bytesRead = bis.read(buffer)) != -1) {
                    digest.update(buffer, 0, bytesRead);
                }
            }

            byte[] hashBytes = digest.digest();
            StringBuilder hexString = new StringBuilder();
            for (byte b : hashBytes) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) {
                    hexString.append('0');
                }
                hexString.append(hex);
            }

            return hexString.toString();
        } catch (Exception e) {
            LOG.warn("[BridgeResolver] Failed to calculate file hash: " + e.getMessage());
            return null;
        }
    }
}


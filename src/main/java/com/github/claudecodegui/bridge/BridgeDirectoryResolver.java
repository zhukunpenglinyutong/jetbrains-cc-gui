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
 * Bridge directory resolver.
 * Responsible for locating and managing the ai-bridge directory (unified bridge for Claude and Codex SDKs).
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
     * Directory path manually set via setSdkDir(), with the highest priority.
     * Difference from cachedSdkDir:
     * - manuallySdkDir: Explicitly set by the user via setSdkDir(), never overridden by auto-discovery
     * - cachedSdkDir: Cached directory found through any means (manual or automatic)
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
     * Find the claude-bridge directory.
     * Priority: manually set path > configured path > embedded path > cached path > fallback
     */
    public File findSdkDir() {
        // Priority 0: Manually set path (via setSdkDir(), highest priority)
        if (this.manuallySdkDir != null && isValidBridgeDir(this.manuallySdkDir)) {
            LOG.debug("[BridgeResolver] Using manually set path: " + this.manuallySdkDir.getAbsolutePath());
            this.cachedSdkDir = this.manuallySdkDir;
            return this.cachedSdkDir;
        }

        // Priority 1: Configured path
        File configuredDir = resolveConfiguredBridgeDir();
        if (configuredDir != null) {
            LOG.debug("[BridgeResolver] Using configured path: " + configuredDir.getAbsolutePath());
            this.cachedSdkDir = configuredDir;
            return this.cachedSdkDir;
        }

        // Check if extraction is already in progress (avoid triggering it again)
        if (this.extractionState.get() == ExtractionState.IN_PROGRESS) {
            LOG.debug("[BridgeResolver] Extraction in progress, returning null");
            return null;
        }

        // Priority 2: Embedded ai-bridge.zip (preferred in production)
        File embeddedDir = ensureEmbeddedBridgeExtracted();
        if (embeddedDir != null) {
            LOG.info("[BridgeResolver] Using embedded path: " + embeddedDir.getAbsolutePath());
            // Verify that node_modules exists
            File nodeModules = new File(embeddedDir, "node_modules");
            LOG.debug("[BridgeResolver] node_modules exists: " + nodeModules.exists());
            this.cachedSdkDir = embeddedDir;
            return this.cachedSdkDir;
        }

        // Re-check: if ensureEmbeddedBridgeExtracted() triggered background extraction (EDT thread scenario),
        // the state will be IN_PROGRESS, and we should return null instead of using a fallback path
        if (this.extractionState.get() == ExtractionState.IN_PROGRESS) {
            LOG.debug("[BridgeResolver] Background extraction started, returning null to avoid incorrect fallback path");
            return null;
        }

        // Priority 3: Use cached path (if it exists and is valid)
        if (this.cachedSdkDir != null && isValidBridgeDir(this.cachedSdkDir)) {
            LOG.debug("[BridgeResolver] Using cached path: " + this.cachedSdkDir.getAbsolutePath());
            return this.cachedSdkDir;
        }

        LOG.debug("[BridgeResolver] Embedded path not found, trying fallback search...");

        // Priority 4: Fallback (development environment)
        // List of possible locations
        List<File> possibleDirs = new ArrayList<>();

        // 1. Current working directory
        File currentDir = new File(System.getProperty("user.dir"));
        addCandidate(possibleDirs, new File(currentDir, SDK_DIR_NAME));

        // 2. Project root directory (the current directory may be in a subdirectory)
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

        // 3. Plugin directory and sandbox
        addPluginCandidates(possibleDirs);

        // 4. Infer from classpath
        addClasspathCandidates(possibleDirs);

        // Find the first valid directory
        for (File dir : possibleDirs) {
            if (isValidBridgeDir(dir)) {
                this.cachedSdkDir = dir;
                LOG.info("[BridgeResolver] Using fallback path: " + this.cachedSdkDir.getAbsolutePath());
                File nodeModules = new File(this.cachedSdkDir, "node_modules");
                LOG.debug("[BridgeResolver] node_modules exists: " + nodeModules.exists());
                return this.cachedSdkDir;
            }
        }

        // If none found, print debug info
        LOG.warn("[BridgeResolver] Cannot find ai-bridge directory, tried locations:");
        for (File dir : possibleDirs) {
            LOG.warn("  - " + dir.getAbsolutePath() + " (exists: " + dir.exists() + ")");
        }

        // Do not return a non-existent default path, as it would cause ProcessBuilder to use an incorrect working directory.
        // For example, when user.dir is "/", it would produce the invalid path "/ai-bridge".
        LOG.error("[BridgeResolver] Failed to find valid ai-bridge directory. " +
                "Please ensure the plugin is properly installed or set CLAUDE_BRIDGE_PATH environment variable.");

        // Check if this is a development environment (source directory missing node_modules)
        for (File dir : possibleDirs) {
            if (dir.exists() && dir.isDirectory()) {
                File nodeModules = new File(dir, "node_modules");
                File packageJson = new File(dir, "package.json");
                if (packageJson.exists() && !nodeModules.exists()) {
                    LOG.warn("[BridgeResolver] Found ai-bridge directory at: " + dir.getAbsolutePath());
                    LOG.warn("[BridgeResolver] But node_modules is missing. This is a development environment issue.");
                    LOG.warn("[BridgeResolver] Please run: cd \"" + dir.getAbsolutePath() + "\" && npm install");
                    break;
                }
            }
        }

        return null;
    }

    /**
     * Resolve the configured bridge directory.
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
     * Validate whether a directory is a valid bridge directory.
     * Checks for the existence of the core script and node_modules.
     *
     * Note: AI SDKs such as @anthropic-ai/claude-agent-sdk are not bundled in ai-bridge.
     * They are loaded dynamically from ~/.codemoss/dependencies/, so SDK presence is not checked here.
     */
    public boolean isValidBridgeDir(File dir) {
        if (dir == null) {
            return false;
        }
        if (!dir.exists() || !dir.isDirectory()) {
            return false;
        }

        // Check for the core script
        File scriptFile = new File(dir, NODE_SCRIPT);
        if (!scriptFile.exists()) {
            LOG.debug("[BridgeResolver] Core script not found: " + scriptFile.getAbsolutePath());
            return false;
        }

        // Check that node_modules exists (contains bridge-layer dependencies like sql.js)
        File nodeModules = new File(dir, "node_modules");
        if (!nodeModules.exists() || !nodeModules.isDirectory()) {
            LOG.debug("[BridgeResolver] node_modules not found: " + dir.getAbsolutePath());
            return false;
        }

        // AI SDKs (@anthropic-ai/claude-agent-sdk, @openai/codex-sdk, etc.)
        // are loaded dynamically from ~/.codemoss/dependencies/, no need to check within ai-bridge

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

                // Try to find by iterating through all plugins
                for (IdeaPluginDescriptor plugin : PluginManagerCore.getPlugins()) {
                    String id = plugin.getPluginId().getIdString();
                    String name = plugin.getName();
                    // Match by plugin ID or name
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
                // Try searching in the lib directory
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

                // If not found in plugin dir or lib, try common sandbox top-level plugins directories and plugins under system/config
                List<File> fallbackCandidates = new ArrayList<>();
                try {
                    // Walk up ancestors to find a potential idea-sandbox root or top-level plugins directory
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

                // Log and try these candidate paths
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
                // Ensure waiters are notified even if the directory already exists
                this.extractionState.compareAndSet(ExtractionState.NOT_STARTED, ExtractionState.COMPLETED);
                if (!this.extractionReadyFuture.isDone()) {
                    this.extractionReadyFuture.complete(true);
                }
                return extractedDir;
            }

            synchronized (this.bridgeExtractionLock) {
                if (isValidBridgeDir(extractedDir) && bridgeSignatureMatches(versionFile, signature)) {
                    this.cachedSdkDir = extractedDir;
                    // Ensure waiters are notified
                    this.extractionState.compareAndSet(ExtractionState.NOT_STARTED, ExtractionState.COMPLETED);
                    if (!this.extractionReadyFuture.isDone()) {
                        this.extractionReadyFuture.complete(true);
                    }
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
                    // Ensure waiters are notified
                    if (!this.extractionReadyFuture.isDone()) {
                        this.extractionReadyFuture.complete(true);
                    }
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

                        // Wait for filesystem to sync and validate with retry
                        // This fixes race condition where unzip returns before files are fully synced
                        File validatedDir = waitForValidBridgeDir(extractedDir, 3, 100);
                        if (validatedDir != null) {
                            this.extractionState.set(ExtractionState.COMPLETED);
                            this.cachedSdkDir = validatedDir;
                            CompletableFuture<File> future = this.extractionFutureRef.get();
                            if (future != null) {
                                future.complete(validatedDir);
                            }
                            this.extractionReadyFuture.complete(true);
                            LOG.info("[BridgeResolver] ai-bridge extraction completed: " + validatedDir.getAbsolutePath());
                            return validatedDir;
                        } else {
                            LOG.error("[BridgeResolver] Bridge validation failed after extraction and retries");
                            this.extractionState.set(ExtractionState.FAILED);
                            CompletableFuture<File> future = this.extractionFutureRef.get();
                            if (future != null) {
                                future.completeExceptionally(new IOException("Bridge validation failed after extraction"));
                            }
                            this.extractionReadyFuture.complete(false);
                            return null;
                        }
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
            // Note: All branches within synchronized block have explicit return statements,
            // so this code path is only reachable if an exception is caught below
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
     * Wait for bridge directory to become valid with retry mechanism.
     * This fixes race condition where filesystem hasn't fully synced after extraction.
     *
     * @param dir The directory to validate
     * @param maxRetries Maximum number of retry attempts
     * @param initialDelayMs Initial delay in milliseconds (doubles with each retry)
     * @return The validated directory, or null if validation fails after all retries
     */
    private File waitForValidBridgeDir(File dir, int maxRetries, int initialDelayMs) {
        int delayMs = initialDelayMs;
        for (int i = 0; i <= maxRetries; i++) {
            if (isValidBridgeDir(dir)) {
                if (i > 0) {
                    LOG.info("[BridgeResolver] Bridge validation succeeded after " + i + " retries");
                }
                return dir;
            }
            if (i < maxRetries) {
                LOG.debug("[BridgeResolver] Bridge validation failed, retrying in " + delayMs + "ms (attempt " + (i + 1) + "/" + (maxRetries + 1) + ")");
                try {
                    Thread.sleep(delayMs);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    LOG.warn("[BridgeResolver] Validation retry interrupted");
                    return null;
                }
                delayMs *= 2; // Exponential backoff
            }
        }
        LOG.warn("[BridgeResolver] Bridge validation failed after " + (maxRetries + 1) + " attempts");
        return null;
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

                        // Validate with retry to handle filesystem sync delay
                        indicator.setText("Validating extraction...");
                        File validatedDir = waitForValidBridgeDir(extractedDir, 3, 100);

                        indicator.setFraction(1.0);

                        if (validatedDir != null) {
                            LOG.info("[BridgeResolver] Background extraction completed successfully");
                            // Mark as completed and cache the directory
                            BridgeDirectoryResolver.this.extractionState.set(ExtractionState.COMPLETED);
                            BridgeDirectoryResolver.this.cachedSdkDir = validatedDir;
                            CompletableFuture<File> future = BridgeDirectoryResolver.this.extractionFutureRef.get();
                            if (future != null) {
                                future.complete(validatedDir);
                            }
                            BridgeDirectoryResolver.this.extractionReadyFuture.complete(true);
                        } else {
                            LOG.error("[BridgeResolver] Background extraction completed but validation failed");
                            BridgeDirectoryResolver.this.extractionState.set(ExtractionState.FAILED);
                            CompletableFuture<File> future = BridgeDirectoryResolver.this.extractionFutureRef.get();
                            if (future != null) {
                                future.completeExceptionally(new IOException("Bridge validation failed after extraction"));
                            }
                            BridgeDirectoryResolver.this.extractionReadyFuture.complete(false);
                        }
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
     * Manually sets the claude-bridge directory path.
     * This path has the highest priority and overrides configured and embedded paths.
     * Once set, findSdkDir() will preferentially return this path.
     *
     * @param path the directory path
     */
    public void setSdkDir(String path) {
        this.manuallySdkDir = new File(path);
        this.cachedSdkDir = this.manuallySdkDir;
        LOG.debug("[BridgeResolver] Manually set SDK directory to: " + path);
    }

    /**
     * Gets the currently used claude-bridge directory.
     */
    public File getSdkDir() {
        if (this.cachedSdkDir == null) {
            return this.findSdkDir();
        }
        return this.cachedSdkDir;
    }

    /**
     * Clears all caches, including manually set paths and auto-discovered caches.
     * After calling this, the next findSdkDir() will re-execute the full path discovery logic.
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


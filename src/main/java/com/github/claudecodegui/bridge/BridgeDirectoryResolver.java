package com.github.claudecodegui.bridge;

import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.openapi.application.PathManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.extensions.PluginId;
import com.intellij.openapi.util.io.FileUtil;

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
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import com.github.claudecodegui.util.PlatformUtils;

/**
 * Bridge Directory Resolver.
 * Responsible for locating and managing the ai-bridge directory (unified Claude and Codex SDK bridge).
 */
public class BridgeDirectoryResolver {

    private static final Logger LOG = Logger.getInstance(BridgeDirectoryResolver.class);
    private static final String SDK_DIR_NAME = "ai-bridge";
    private static final String NODE_SCRIPT = "channel-manager.js";
    private static final String SDK_ARCHIVE_NAME = "ai-bridge.zip";
    private static final String BRIDGE_VERSION_FILE = ".bridge-version";
    private static final String BRIDGE_PATH_PROPERTY = "claude.bridge.path";
    private static final String BRIDGE_PATH_ENV = "CLAUDE_BRIDGE_PATH";
    private static final String PLUGIN_ID = "com.lacrearthur.idea-claude-gui";
    private static final String PLUGIN_DIR_NAME = "idea-claude-gui";

    private File cachedSdkDir = null;
    private final Object bridgeExtractionLock = new Object();

    /**
     * Find the claude-bridge directory.
     * Priority: Configured path > Embedded path > Cached path > Fallback
     */
    public File findSdkDir() {
        // Priority 1: Configured path (highest priority)
        File configuredDir = resolveConfiguredBridgeDir();
        if (configuredDir != null) {
            LOG.info("[BridgeResolver] Using configured path: " + configuredDir.getAbsolutePath());
            cachedSdkDir = configuredDir;
            return cachedSdkDir;
        }

        // ✓ 优先级 2: 嵌入式 ai-bridge.zip（生产环境优先）
        File embeddedDir = ensureEmbeddedBridgeExtracted();
        if (embeddedDir != null) {
            LOG.info("[BridgeResolver] Using embedded path: " + embeddedDir.getAbsolutePath());
            // Verify node_modules exists
            File nodeModules = new File(embeddedDir, "node_modules");
            LOG.info("[BridgeResolver] node_modules exists: " + nodeModules.exists());
            cachedSdkDir = embeddedDir;
            return cachedSdkDir;
        }

        // Priority 3: Use cached path (if exists and valid)
        if (cachedSdkDir != null && isValidBridgeDir(cachedSdkDir)) {
            LOG.info("[BridgeResolver] Using cached path: " + cachedSdkDir.getAbsolutePath());
            return cachedSdkDir;
        }

        LOG.info("[BridgeResolver] Embedded path not found, trying fallback...");

        // Priority 4: Fallback (development environment)
        // List of possible locations
        List<File> possibleDirs = new ArrayList<>();

        // 1. Current working directory
        File currentDir = new File(System.getProperty("user.dir"));
        addCandidate(possibleDirs, new File(currentDir, SDK_DIR_NAME));

        // 2. Project root directory (assuming current dir may be in a subdirectory)
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

        // Find the first existing directory
        for (File dir : possibleDirs) {
            if (isValidBridgeDir(dir)) {
                cachedSdkDir = dir;
                LOG.info("[BridgeResolver] ✓ Using fallback path: " + cachedSdkDir.getAbsolutePath());
                File nodeModules = new File(cachedSdkDir, "node_modules");
                LOG.info("[BridgeResolver] node_modules exists: " + nodeModules.exists());
                return cachedSdkDir;
            }
        }

        // If none found, print debug info
        LOG.warn("⚠️ Unable to find ai-bridge directory, tried the following locations:");
        for (File dir : possibleDirs) {
            LOG.warn("  - " + dir.getAbsolutePath() + " (exists: " + dir.exists() + ")");
        }

        // Return default value
        cachedSdkDir = new File(currentDir, SDK_DIR_NAME);
        LOG.warn("  Using default path: " + cachedSdkDir.getAbsolutePath());
        return cachedSdkDir;
    }

    /**
     * Resolve the configured Bridge directory.
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
            LOG.info("✓ Using " + source + ": " + dir.getAbsolutePath());
            return dir;
        }
        LOG.warn("⚠️ " + source + " points to invalid directory: " + dir.getAbsolutePath());
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
            LOG.debug("  Unable to infer from plugin descriptor: " + t.getMessage());
        }

        try {
            String pluginsRoot = PathManager.getPluginsPath();
            if (!pluginsRoot.isEmpty()) {
                addCandidate(possibleDirs, Paths.get(pluginsRoot, PLUGIN_DIR_NAME, SDK_DIR_NAME).toFile());
                addCandidate(possibleDirs, Paths.get(pluginsRoot, PLUGIN_ID, SDK_DIR_NAME).toFile());
            }

            // Use system path plugins directory instead of deprecated getPluginTempPath()
            String systemPath = PathManager.getSystemPath();
            if (!systemPath.isEmpty()) {
                Path sandboxPath = Paths.get(systemPath, "plugins");
                addCandidate(possibleDirs, sandboxPath.resolve(PLUGIN_DIR_NAME).resolve(SDK_DIR_NAME).toFile());
                addCandidate(possibleDirs, sandboxPath.resolve(PLUGIN_ID).resolve(SDK_DIR_NAME).toFile());
            }
        } catch (Throwable t) {
            LOG.debug("  Unable to infer from plugin path: " + t.getMessage());
        }
    }

    private void addClasspathCandidates(List<File> possibleDirs) {
        try {
            CodeSource codeSource = BridgeDirectoryResolver.class.getProtectionDomain().getCodeSource();
            if (codeSource == null || codeSource.getLocation() == null) {
                LOG.debug("  Unable to infer from classpath: CodeSource not available");
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
            LOG.debug("  Unable to infer from classpath: " + e.getMessage());
        }
    }

    /**
     * Validate whether the directory is a valid bridge directory.
     * Enhanced validation: checks core script and key dependencies
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
            LOG.info("[BridgeResolver] Attempting to find embedded ai-bridge.zip...");

            PluginId pluginId = PluginId.getId(PLUGIN_ID);
            IdeaPluginDescriptor descriptor = PluginManagerCore.getPlugin(pluginId);
            if (descriptor == null) {
                LOG.info("[BridgeResolver] Unable to get plugin descriptor via PluginId: " + PLUGIN_ID);

                // Try to find by iterating through all plugins
                for (IdeaPluginDescriptor plugin : PluginManagerCore.getPlugins()) {
                    String id = plugin.getPluginId().getIdString();
                    String name = plugin.getName();
                    // Match plugin ID or name
                    if (id.contains("claude") || id.contains("Claude") ||
                        (name != null && (name.contains("Claude") || name.contains("claude")))) {
                        LOG.info("[BridgeResolver] Found candidate plugin: id=" + id + ", name=" + name + ", path=" + plugin.getPluginPath());
                        File candidateDir = plugin.getPluginPath().toFile();
                        File candidateArchive = new File(candidateDir, SDK_ARCHIVE_NAME);
                        if (candidateArchive.exists()) {
                            LOG.info("[BridgeResolver] Found ai-bridge.zip in candidate plugin: " + candidateArchive.getAbsolutePath());
                            descriptor = plugin;
                            break;
                        }
                    }
                }

                if (descriptor == null) {
                    LOG.info("[BridgeResolver] Unable to find plugin descriptor by any method");
                    return null;
                }
            }

            File pluginDir = descriptor.getPluginPath().toFile();
            LOG.info("[BridgeResolver] Plugin directory: " + pluginDir.getAbsolutePath());

            File archiveFile = new File(pluginDir, SDK_ARCHIVE_NAME);
            LOG.info("[BridgeResolver] Looking for archive: " + archiveFile.getAbsolutePath() + " (exists: " + archiveFile.exists() + ")");

            if (!archiveFile.exists()) {
                // Try looking in lib directory
                File libDir = new File(pluginDir, "lib");
                if (libDir.exists()) {
                    LOG.info("[BridgeResolver] Checking lib directory: " + libDir.getAbsolutePath());
                    File[] files = libDir.listFiles();
                    if (files != null) {
                        for (File f : files) {
                            LOG.info("[BridgeResolver]   - " + f.getName());
                        }
                    }
                }

                // If not found in plugin dir or lib, try common sandbox top-level plugins dir and system/config plugins
                List<File> fallbackCandidates = new ArrayList<>();
                try {
                    // Traverse up to find possible idea-sandbox root or directory containing top-level plugins
                    File ancestor = pluginDir;
                    int climbs = 0;
                    while (climbs < 6) {
                        File parentDir = ancestor.getParentFile();
                        if (parentDir == null) break;

                        File maybeTopPlugins = new File(parentDir, "plugins");
                        if (maybeTopPlugins.exists() && maybeTopPlugins.isDirectory()) {
                            fallbackCandidates.add(new File(maybeTopPlugins, PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                            fallbackCandidates.add(new File(maybeTopPlugins, PLUGIN_ID + File.separator + SDK_ARCHIVE_NAME));
                        }

                        // system/config siblings under this parent
                        File maybeSystemPlugins = new File(parentDir, "system/plugins");
                        File maybeConfigPlugins = new File(parentDir, "config/plugins");
                        if (maybeSystemPlugins.exists() && maybeSystemPlugins.isDirectory()) {
                            fallbackCandidates.add(new File(maybeSystemPlugins, PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                            fallbackCandidates.add(new File(maybeSystemPlugins, PLUGIN_ID + File.separator + SDK_ARCHIVE_NAME));
                        }
                        if (maybeConfigPlugins.exists() && maybeConfigPlugins.isDirectory()) {
                            fallbackCandidates.add(new File(maybeConfigPlugins, PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                            fallbackCandidates.add(new File(maybeConfigPlugins, PLUGIN_ID + File.separator + SDK_ARCHIVE_NAME));
                        }

                        ancestor = parentDir;
                        climbs++;
                    }
                } catch (Throwable ignore) {
                    // ignore fallback discovery errors
                }

                // Print and try these candidate paths
                for (File f : fallbackCandidates) {
                    LOG.info("[BridgeResolver] Trying candidate path: " + f.getAbsolutePath() + " (exists: " + f.exists() + ")");
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

                LOG.info("Extracted ai-bridge not detected, starting extraction: " + archiveFile.getAbsolutePath());
                deleteDirectory(extractedDir);
                unzipArchive(archiveFile, extractedDir);
                Files.writeString(versionFile.toPath(), signature, StandardCharsets.UTF_8);
            }

            if (isValidBridgeDir(extractedDir)) {
                LOG.info("✓ ai-bridge extraction complete: " + extractedDir.getAbsolutePath());
                return extractedDir;
            }

            LOG.warn("⚠️ ai-bridge structure invalid after extraction: " + extractedDir.getAbsolutePath());
        } catch (Exception e) {
            LOG.error("⚠️ Auto-extraction of ai-bridge failed: " + e.getMessage());
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
        // Use retry mechanism for directory deletion, handles Windows file locking issues
        if (!PlatformUtils.deleteDirectoryWithRetry(dir, 3)) {
            // If retry fails, fall back to IntelliJ's FileUtil
            if (!FileUtil.delete(dir)) {
                LOG.warn("⚠️ Unable to delete directory: " + dir.getAbsolutePath());
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
                    throw new IOException("Detected unsafe Zip entry: " + entry.getName());
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
     * Manually set the claude-bridge directory path.
     */
    public void setSdkDir(String path) {
        this.cachedSdkDir = new File(path);
    }

    /**
     * Get the currently used claude-bridge directory.
     */
    public File getSdkDir() {
        if (this.cachedSdkDir == null) {
            return this.findSdkDir();
        }
        return this.cachedSdkDir;
    }

    /**
     * Clear the cache.
     */
    public void clearCache() {
        this.cachedSdkDir = null;
    }
}

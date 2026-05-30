package com.github.claudecodegui.bridge;

import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.PluginMetadata;
import com.intellij.openapi.application.PathManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Locates the bundled {@code ai-bridge.zip} archive across plugin installation
 * and sandbox layouts. Splits descriptor lookup and sandbox fallback search out
 * of the resolver facade so the extraction orchestration stays compact.
 *
 * <p>Package-private helper extracted from {@link BridgeDirectoryResolver}.
 */
final class BridgeArchiveLocator {

    private static final Logger LOG = Logger.getInstance(BridgeArchiveLocator.class);

    static final String SDK_ARCHIVE_NAME = "ai-bridge.zip";

    /**
     * Resolution result: the plugin directory plus plugin version used for the
     * archive freshness signature.
     */
    static final class PluginLocation {
        final File pluginDir;
        final String version;

        PluginLocation(File pluginDir, String version) {
            this.pluginDir = pluginDir;
            this.version = version;
        }
    }

    private BridgeArchiveLocator() {
    }

    /**
     * Resolve the plugin directory without using plugin-manager internals.
     */
    static PluginLocation resolvePluginLocation() {
        String expectedId = PlatformUtils.getPluginId();
        LOG.info("[BridgeResolver] Plugin ID: " + expectedId);

        for (File candidate : collectPluginDirCandidates(PluginMetadata.getPluginDirectory(BridgeArchiveLocator.class))) {
            File archiveFile = locateArchive(candidate);
            if (archiveFile != null) {
                File pluginDir = archiveFile.getParentFile();
                LOG.debug("[BridgeResolver] Plugin directory with archive: " + pluginDir.getAbsolutePath());
                return new PluginLocation(pluginDir, PluginMetadata.getPluginVersion());
            }
        }

        LOG.debug("[BridgeResolver] Could not resolve plugin directory containing " + SDK_ARCHIVE_NAME);
        return null;
    }

    static List<File> collectPluginDirCandidates(File classpathPluginDir) {
        List<File> candidates = new ArrayList<>();
        addCandidate(candidates, classpathPluginDir);

        try {
            String pluginsRoot = PathManager.getPluginsPath();
            if (pluginsRoot != null && !pluginsRoot.isEmpty()) {
                addPluginRootCandidates(candidates, new File(pluginsRoot));
            }

            String systemPath = PathManager.getSystemPath();
            if (systemPath != null && !systemPath.isEmpty()) {
                addPluginRootCandidates(candidates, new File(systemPath, "plugins"));
            }
        } catch (Throwable t) {
            LOG.debug("[BridgeResolver] Cannot infer plugin roots from PathManager: " + t.getMessage());
        }

        if (classpathPluginDir != null) {
            File ancestor = classpathPluginDir;
            int climbs = 0;
            while (ancestor != null && climbs < 8) {
                addPluginRootCandidates(candidates, ancestor);
                addPluginRootCandidates(candidates, new File(ancestor, "plugins"));
                addPluginRootCandidates(candidates, new File(ancestor, "system/plugins"));
                addPluginRootCandidates(candidates, new File(ancestor, "config/plugins"));
                addIdeaSandboxCandidates(candidates, new File(ancestor, "build/idea-sandbox"));
                ancestor = ancestor.getParentFile();
                climbs++;
            }
        }

        return candidates;
    }

    private static void addIdeaSandboxCandidates(List<File> candidates, File sandboxRoot) {
        if (sandboxRoot == null || !sandboxRoot.isDirectory()) {
            return;
        }

        File[] ideSandboxes = sandboxRoot.listFiles(File::isDirectory);
        if (ideSandboxes == null) {
            return;
        }

        for (File ideSandbox : ideSandboxes) {
            addPluginRootCandidates(candidates, new File(ideSandbox, "plugins"));
        }
    }

    private static void addPluginRootCandidates(List<File> candidates, File pluginsRoot) {
        if (pluginsRoot == null) {
            return;
        }
        addCandidate(candidates, new File(pluginsRoot, BridgePathLocator.PLUGIN_DIR_NAME));
        addCandidate(candidates, new File(pluginsRoot, PlatformUtils.getPluginId()));
    }

    private static void addCandidate(List<File> candidates, File candidate) {
        if (candidate == null) {
            return;
        }
        String path = candidate.getAbsolutePath();
        for (File existing : candidates) {
            if (existing.getAbsolutePath().equals(path)) {
                return;
            }
        }
        candidates.add(candidate);
    }

    /**
     * Locate the archive file for the given plugin directory. First checks
     * {@code <pluginDir>/ai-bridge.zip}, then walks ancestor sandbox layouts
     * (top-level {@code plugins/}, {@code system/plugins}, {@code config/plugins}).
     *
     * @return the archive file, or {@code null} if it cannot be found.
     */
    static File locateArchive(File pluginDir) {
        File archiveFile = new File(pluginDir, SDK_ARCHIVE_NAME);
        LOG.info("[BridgeResolver] Looking for archive: " + archiveFile.getAbsolutePath());
        LOG.info("[BridgeResolver] Archive exists: " + archiveFile.exists());
        if (archiveFile.exists()) {
            LOG.info("[BridgeResolver] Archive size: " + archiveFile.length() + " bytes");
            return archiveFile;
        }

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
        List<File> fallbackCandidates = collectSandboxFallbacks(pluginDir);

        // Log and try these candidate paths
        for (File f : fallbackCandidates) {
            LOG.debug("[BridgeResolver] Trying candidate path: " + f.getAbsolutePath() + " (exists: " + f.exists() + ")");
            if (f.exists()) {
                return f;
            }
        }

        return null;
    }

    private static List<File> collectSandboxFallbacks(File pluginDir) {
        List<File> fallbackCandidates = new ArrayList<>();
        try {
            // Walk up ancestors to find a potential idea-sandbox root or top-level plugins directory
            File ancestor = pluginDir;
            int climbs = 0;
            while (climbs < 6) {
                File parent = ancestor.getParentFile();
                if (parent == null) { break; }

                File maybeTopPlugins = new File(parent, "plugins");
                if (maybeTopPlugins.exists() && maybeTopPlugins.isDirectory()) {
                    fallbackCandidates.add(new File(maybeTopPlugins, BridgePathLocator.PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                    fallbackCandidates.add(new File(maybeTopPlugins, PlatformUtils.getPluginId() + File.separator + SDK_ARCHIVE_NAME));
                }

                // system/config siblings under this parent
                File maybeSystemPlugins = new File(parent, "system/plugins");
                File maybeConfigPlugins = new File(parent, "config/plugins");
                if (maybeSystemPlugins.exists() && maybeSystemPlugins.isDirectory()) {
                    fallbackCandidates.add(new File(maybeSystemPlugins, BridgePathLocator.PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                    fallbackCandidates.add(new File(maybeSystemPlugins, PlatformUtils.getPluginId() + File.separator + SDK_ARCHIVE_NAME));
                }
                if (maybeConfigPlugins.exists() && maybeConfigPlugins.isDirectory()) {
                    fallbackCandidates.add(new File(maybeConfigPlugins, BridgePathLocator.PLUGIN_DIR_NAME + File.separator + SDK_ARCHIVE_NAME));
                    fallbackCandidates.add(new File(maybeConfigPlugins, PlatformUtils.getPluginId() + File.separator + SDK_ARCHIVE_NAME));
                }

                ancestor = parent;
                climbs++;
            }
        } catch (Throwable ignore) {
            // ignore fallback discovery errors
        }
        return fallbackCandidates;
    }

    /**
     * Compute the expected signature for the located archive. Combines the
     * plugin version with either a precomputed hash or a runtime SHA-256.
     */
    static String computeSignature(PluginLocation pluginLocation, File archiveFile) {
        // Prefer precomputed hash file (generated at build time) to avoid runtime calculation overhead
        // Note: hash file should be in the same directory as archiveFile
        File archiveParentDir = archiveFile.getParentFile();
        String archiveHash = BridgeSignatureVerifier.readPrecomputedHash(archiveParentDir);
        if (archiveHash == null) {
            LOG.info("[BridgeResolver] Precomputed hash file not found, falling back to runtime calculation");
            archiveHash = BridgeSignatureVerifier.calculateFileHash(archiveFile);
        }
        if (archiveHash == null) {
            LOG.warn("[BridgeResolver] Failed to calculate archive hash, falling back to version-based signature");
            archiveHash = "unknown";
        }
        return pluginLocation.version + ":" + archiveHash;
    }
}

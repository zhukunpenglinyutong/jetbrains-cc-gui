package com.github.claudecodegui.bridge;

import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.extensions.PluginId;

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
     * Resolution result: the descriptor that owns the archive plus the archive
     * file location (which may live in a sandbox parallel to the descriptor's
     * own plugin path).
     */
    static final class ArchiveLocation {
        final IdeaPluginDescriptor descriptor;
        final File archiveFile;

        ArchiveLocation(IdeaPluginDescriptor descriptor, File archiveFile) {
            this.descriptor = descriptor;
            this.archiveFile = archiveFile;
        }
    }

    private BridgeArchiveLocator() {
    }

    /**
     * Resolve the {@link IdeaPluginDescriptor} that contains ai-bridge.zip,
     * falling back to a name/id-based scan of all loaded plugins when the
     * primary id lookup fails.
     *
     * <p>The primary lookup uses {@code findEnabledPlugin}, which is sufficient
     * because we are looking up our own plugin (running code means enabled).
     * The fallback scan exists for dev sandbox scenarios where the plugin id
     * detected at runtime may not match the descriptor registered with the
     * platform.
     */
    static IdeaPluginDescriptor resolveDescriptor() {
        String expectedId = PlatformUtils.getPluginId();
        PluginId pluginId = PluginId.getId(expectedId);
        LOG.info("[BridgeResolver] Plugin ID: " + expectedId);
        IdeaPluginDescriptor descriptor = PluginManager.getInstance().findEnabledPlugin(pluginId);
        if (descriptor != null) {
            return descriptor;
        }

        LOG.warn("[BridgeResolver] Cannot get plugin descriptor by PluginId: " + expectedId);

        // Fallback: scan all plugins. PluginManager.getPlugins() is @Deprecated but
        // remains the only public API for enumerating all plugins; verifier treats
        // it as a deprecation warning, not an INTERNAL_API_USAGES failure.
        // Match priority: (1) exact id, (2) id contains "claude", (3) name contains "Claude".
        IdeaPluginDescriptor idMatch = null;
        IdeaPluginDescriptor nameMatch = null;
        for (IdeaPluginDescriptor plugin : PluginManager.getPlugins()) {
            String id = plugin.getPluginId().getIdString();
            String name = plugin.getName();

            if (expectedId.equals(id)) {
                LOG.debug("[BridgeResolver] Exact id match: " + id + ", path=" + plugin.getPluginPath());
                return plugin;
            }
            if (idMatch == null && (id.contains("claude") || id.contains("Claude"))) {
                idMatch = plugin;
            } else if (nameMatch == null && name != null && (name.contains("Claude") || name.contains("claude"))) {
                nameMatch = plugin;
            }
        }

        IdeaPluginDescriptor candidate = idMatch != null ? idMatch : nameMatch;
        if (candidate != null) {
            LOG.debug("[BridgeResolver] Fuzzy match: id=" + candidate.getPluginId().getIdString()
                    + ", name=" + candidate.getName() + ", path=" + candidate.getPluginPath());
            File candidateArchive = new File(candidate.getPluginPath().toFile(), SDK_ARCHIVE_NAME);
            if (candidateArchive.exists()) {
                LOG.debug("[BridgeResolver] Found ai-bridge.zip in candidate plugin: " + candidateArchive.getAbsolutePath());
                return candidate;
            }
        }

        LOG.debug("[BridgeResolver] Could not find plugin descriptor by any method");
        return null;
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
    static String computeSignature(IdeaPluginDescriptor descriptor, File archiveFile) {
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
        return descriptor.getVersion() + ":" + archiveHash;
    }
}

package com.github.claudecodegui.bridge;

import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.openapi.application.PathManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.extensions.PluginId;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.CodeSource;
import java.util.List;

/**
 * Locates candidate ai-bridge directories across the user/system paths and
 * validates that a given directory is a usable bridge install.
 *
 * <p>Package-private helper extracted from {@link BridgeDirectoryResolver}.
 */
final class BridgePathLocator {

    private static final Logger LOG = Logger.getInstance(BridgePathLocator.class);

    static final String SDK_DIR_NAME = "ai-bridge";
    static final String NODE_SCRIPT = "channel-manager.js";
    static final String PLUGIN_DIR_NAME = "idea-claude-code-gui";
    static final String BRIDGE_PATH_PROPERTY = "claude.bridge.path";
    static final String BRIDGE_PATH_ENV = "CLAUDE_BRIDGE_PATH";

    private BridgePathLocator() {
    }

    /**
     * Resolve the configured bridge directory.
     */
    static File resolveConfiguredBridgeDir() {
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

    private static File tryResolveConfiguredPath(String path, String source) {
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

    static void addPluginCandidates(List<File> possibleDirs) {
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

    static void addClasspathCandidates(List<File> possibleDirs) {
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

    static void addCandidate(List<File> possibleDirs, File dir) {
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

    static boolean isRootDirectory(File dir) {
        return dir.getParentFile() == null;
    }

    /**
     * Validate whether a directory is a valid bridge directory.
     * Checks for the existence of the core script and node_modules.
     *
     * Note: AI SDKs such as @anthropic-ai/claude-agent-sdk are not bundled in ai-bridge.
     * They are loaded dynamically from ~/.codemoss/dependencies/, so SDK presence is not checked here.
     */
    static boolean isValidBridgeDir(File dir) {
        LOG.debug("[BridgeResolver] Validating bridge dir: " + (dir != null ? dir.getAbsolutePath() : "null"));
        if (dir == null) {
            LOG.debug("[BridgeResolver] Validation failed: dir is null");
            return false;
        }
        if (!dir.exists()) {
            LOG.debug("[BridgeResolver] Validation failed: dir does not exist");
            return false;
        }
        if (!dir.isDirectory()) {
            LOG.debug("[BridgeResolver] Validation failed: dir is not a directory");
            return false;
        }

        // Check for the core script
        File scriptFile = new File(dir, NODE_SCRIPT);
        LOG.debug("[BridgeResolver] Checking for core script: " + scriptFile.getAbsolutePath());
        if (!scriptFile.exists()) {
            LOG.debug("[BridgeResolver] Validation failed: Core script not found: " + scriptFile.getAbsolutePath());
            return false;
        }
        LOG.debug("[BridgeResolver] Core script found");

        // Check that node_modules exists (contains bridge-layer dependencies like sql.js)
        File nodeModules = new File(dir, "node_modules");
        LOG.debug("[BridgeResolver] Checking for node_modules: " + nodeModules.getAbsolutePath());
        if (!nodeModules.exists() || !nodeModules.isDirectory()) {
            LOG.debug("[BridgeResolver] Validation failed: node_modules not found or not a directory");
            return false;
        }
        LOG.debug("[BridgeResolver] node_modules found");

        // AI SDKs (@anthropic-ai/claude-agent-sdk, @openai/codex-sdk, etc.)
        // are loaded dynamically from ~/.codemoss/dependencies/, no need to check within ai-bridge

        return true;
    }
}

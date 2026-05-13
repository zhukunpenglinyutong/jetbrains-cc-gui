package com.github.claudecodegui.skill;

import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

final class SlashCommandPathPolicy {

    private static final Logger LOG = Logger.getInstance(SlashCommandPathPolicy.class);
    private static final Pattern SAFE_PLUGIN_ID = Pattern.compile("^[a-zA-Z0-9._@/\\-]+$");
    private static final int MAX_GLOB_PATTERN_LENGTH = 256;
    private static final Pattern DANGEROUS_GLOB = Pattern.compile("(\\*\\*/){5,}");

    private SlashCommandPathPolicy() {
    }

    static boolean isSafePluginId(String pluginId) {
        return pluginId != null
                && SAFE_PLUGIN_ID.matcher(pluginId).matches()
                && !pluginId.contains("..");
    }

    static boolean matchesPathPatterns(Path currentFile, List<String> patterns) {
        if (patterns == null || patterns.isEmpty()) {
            return true;
        }
        if (currentFile == null) {
            return false;
        }

        String normalized = currentFile.toString().replace('\\', '/');
        for (String pattern : patterns) {
            if (pattern == null || pattern.trim().isEmpty()) {
                continue;
            }

            String trimmed = pattern.trim();
            if (trimmed.length() > MAX_GLOB_PATTERN_LENGTH) {
                LOG.debug("Pattern too long, skip: " + trimmed.substring(0, 50) + "...");
                continue;
            }

            String patternBody = trimmed.startsWith("glob:") ? trimmed.substring(5) : trimmed;
            if (DANGEROUS_GLOB.matcher(patternBody).find()) {
                LOG.debug("Pattern too complex, skip: " + trimmed);
                continue;
            }

            String candidatePattern = trimmed.startsWith("glob:") ? trimmed : "glob:" + trimmed;

            try {
                PathMatcher matcher = Paths.get("").getFileSystem().getPathMatcher(candidatePattern);
                Path currentPath = Paths.get(normalized);
                if (matcher.matches(currentPath)) {
                    return true;
                }

                Path fileName = currentFile.getFileName();
                if (fileName != null && matcher.matches(fileName)) {
                    return true;
                }

                for (int i = 0; i < currentPath.getNameCount(); i++) {
                    if (matcher.matches(currentPath.subpath(i, currentPath.getNameCount()))) {
                        return true;
                    }
                }
            } catch (Exception e) {
                LOG.debug("Invalid path pattern, skip: " + trimmed);
            }
        }

        return false;
    }

    static String normalizePath(String path) {
        if (path == null || path.isEmpty()) {
            return path;
        }
        try {
            return Paths.get(path).toAbsolutePath().normalize().toString();
        } catch (Exception e) {
            return path;
        }
    }

    static Path toNormalizedPath(String path) {
        if (path == null || path.isEmpty()) {
            return null;
        }
        try {
            return Paths.get(path).toAbsolutePath().normalize();
        } catch (Exception e) {
            return null;
        }
    }

    static Path resolveManagedSkillsDirectory(Path managedPath) {
        Path candidate = managedPath.resolve(".claude").resolve("skills");
        if (Files.isDirectory(candidate)) {
            return candidate;
        }
        Path directSkills = managedPath.resolve("skills");
        if (Files.isDirectory(directSkills)) {
            return directSkills;
        }
        if (Files.isDirectory(managedPath) && managedPath.getFileName() != null
                && "skills".equals(managedPath.getFileName().toString())) {
            return managedPath;
        }
        return null;
    }

    static boolean isManagedPathSafe(Path managedPath) {
        if (managedPath == null || !managedPath.isAbsolute()) {
            return false;
        }
        try {
            Path realPath = managedPath.toRealPath();
            if (!Files.isDirectory(realPath)) {
                return false;
            }
            // Reject filesystem root or paths too close to root (e.g. /tmp, C:\)
            // to prevent accidental scanning of large directory trees.
            // A depth > 1 ensures at least two path components (e.g. /opt/managed).
            if (realPath.getNameCount() <= 1) {
                return false;
            }
            // Reject well-known sensitive directories
            String first = realPath.getName(0).toString().toLowerCase();
            if ("etc".equals(first) || "windows".equals(first) || "system32".equals(first)) {
                return false;
            }
            return true;
        } catch (IOException e) {
            LOG.debug("Cannot resolve real path for managed directory safety check: " + managedPath);
            return false;
        }
    }

    static Path resolvePluginSubPath(Path pluginDir, String declaredPath) {
        try {
            String trimmedPath = declaredPath == null ? "" : declaredPath.trim();
            Path path = Paths.get(trimmedPath);
            if (path.isAbsolute() || path.getRoot() != null
                    || trimmedPath.startsWith("/") || trimmedPath.startsWith("\\")) {
                LOG.warn("Rejecting absolute plugin path: " + declaredPath);
                return null;
            }
            return pluginDir.resolve(path).normalize();
        } catch (Exception e) {
            return null;
        }
    }

    static boolean isPluginPathSafe(Path subPath, Path pluginDir) {
        if (subPath == null || pluginDir == null) {
            return false;
        }

        try {
            Path realSubPath = subPath.toRealPath();
            Path realPluginDir = pluginDir.toRealPath();

            if (!realSubPath.startsWith(realPluginDir)) {
                return false;
            }

            return !realSubPath.equals(realPluginDir);
        } catch (IOException e) {
            LOG.debug("Cannot resolve real path for plugin path safety check: " + subPath);
            return false;
        }
    }

    static Path resolvePluginManifestPath(Path pluginDir) {
        if (pluginDir == null) {
            return null;
        }
        Path claudePluginManifest = pluginDir.resolve(".claude-plugin").resolve("plugin.json");
        if (Files.isRegularFile(claudePluginManifest)) {
            return claudePluginManifest;
        }
        Path rootManifest = pluginDir.resolve("plugin.json");
        if (Files.isRegularFile(rootManifest)) {
            return rootManifest;
        }
        return null;
    }

    static Path resolveMarketplaceManifestPath(
            String pluginName,
            String marketplaceId,
            Map<String, String> knownMarketplaces
    ) {
        if (marketplaceId == null || knownMarketplaces == null) {
            return null;
        }
        if (pluginName == null || pluginName.contains("..")) {
            return null;
        }

        String installLocation = knownMarketplaces.get(marketplaceId);
        if (installLocation == null || installLocation.isEmpty()) {
            return null;
        }

        try {
            Path marketplaceDir = Paths.get(installLocation).toAbsolutePath().normalize();
            Path pluginsDir = marketplaceDir.resolve("plugins");
            Path pluginEntry = pluginsDir.resolve(pluginName).toAbsolutePath().normalize();
            if (!pluginEntry.startsWith(pluginsDir)) {
                LOG.warn("Plugin path escaped marketplace plugins dir: " + pluginEntry);
                return null;
            }
            return resolvePluginManifestPath(pluginEntry);
        } catch (Exception e) {
            LOG.debug("Failed to resolve marketplace manifest for plugin: " + pluginName);
            return null;
        }
    }
}

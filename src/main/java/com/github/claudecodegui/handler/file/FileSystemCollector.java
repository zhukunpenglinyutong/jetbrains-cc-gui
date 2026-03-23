package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.util.IgnoreRuleMatcher;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Collects files from the file system via directory scanning.
 * Handles recursive search, directory listing, and .gitignore rules.
 */
class FileSystemCollector {

    private static final Logger LOG = Logger.getInstance(FileSystemCollector.class);

    private static final int MAX_SEARCH_RESULTS = 200;
    private static final int MAX_SEARCH_DEPTH = 15;
    private static final int MAX_DIRECTORY_CHILDREN = 100;

    // Directories always skipped (version control, package management, build cache, IDE config, etc.)
    private static final Set<String> ALWAYS_SKIP_DIRS = Set.of(
            // Version control
            ".git", ".svn", ".hg", ".bzr",
            // Package management and dependency cache
            "node_modules", "__pycache__", ".pnpm", "bower_components",
            // Java/JVM build cache
            ".m2", ".gradle", ".ivy2", ".sbt", ".coursier",
            // Other language package management cache
            ".npm", ".yarn", ".pnpm-store", ".cargo", ".rustup",
            ".pub-cache", ".gem", ".bundle", ".composer", ".nuget",
            ".cache", ".local",
            // Build output directories
            "target", "build", "dist", "out", "output", "bin", "obj",
            // IDE and editor configuration
            ".idea", ".vscode", ".vs", ".eclipse", ".settings",
            // Virtual environments
            "venv", ".venv", "env", ".env", "virtualenv",
            // Testing and coverage
            "coverage", ".nyc_output", ".pytest_cache", "__snapshots__",
            // Temporary and log files
            "tmp", "temp", "logs", ".tmp", ".temp"
    );

    // Files always skipped
    private static final Set<String> ALWAYS_SKIP_FILES = Set.of(
            ".DS_Store", "Thumbs.db", "desktop.ini"
    );

    // Ignore rule matcher cache — volatile for thread safety
    private volatile IgnoreRuleMatcher cachedIgnoreMatcher = null;
    private volatile String cachedIgnoreMatcherBasePath = null;
    private volatile long cachedGitignoreLastModified = 0;

    FileSystemCollector() {
    }

    /**
     * Collect files from the file system.
     */
    void collect(List<JsonObject> files, FileHandler.FileSet fileSet, String basePath, FileHandler.FileListRequest request) {
        List<JsonObject> diskFiles = new ArrayList<>();

        // Get or create ignore rule matcher
        IgnoreRuleMatcher ignoreMatcher = getOrCreateIgnoreMatcher(basePath);

        if (request.hasQuery) {
            File baseDir = new File(basePath);
            collectFilesRecursive(baseDir, basePath, diskFiles, request, 0, ignoreMatcher);
        } else {
            File targetDir = new File(basePath, request.currentPath);
            if (targetDir.exists() && targetDir.isDirectory()) {
                listDirectChildren(targetDir, basePath, diskFiles, ignoreMatcher);
            }
        }

        // Merge disk scan results
        for (JsonObject fileObj : diskFiles) {
            String absPath = fileObj.get("absolutePath").getAsString();
            if (fileSet.tryAdd(absPath)) {
                fileObj.addProperty("priority", 3);
                files.add(fileObj);
            }
        }
    }

    /**
     * Determine whether to skip a file or directory (basic version, checks hardcoded lists only).
     */
    static boolean shouldSkipInSearch(String name, boolean isDirectory) {
        if (isDirectory) {
            return ALWAYS_SKIP_DIRS.contains(name);
        }
        return ALWAYS_SKIP_FILES.contains(name);
    }

    /**
     * Determine whether to skip a file or directory (includes .gitignore rule checking).
     */
    private boolean shouldSkipInSearch(String name, boolean isDirectory, String relativePath, IgnoreRuleMatcher matcher) {
        // First check the hardcoded exclusion list
        if (shouldSkipInSearch(name, isDirectory)) {
            return true;
        }

        // Then check .gitignore rules
        if (matcher != null && relativePath != null) {
            return matcher.isIgnored(relativePath, isDirectory);
        }

        return false;
    }

    /**
     * List direct children of a directory (non-recursive).
     */
    private void listDirectChildren(File dir, String basePath, List<JsonObject> files, IgnoreRuleMatcher ignoreMatcher) {
        if (!dir.isDirectory()) return;

        File[] children = dir.listFiles();
        if (children == null) return;

        int added = 0;
        for (File child : children) {
            if (added >= MAX_DIRECTORY_CHILDREN) break;

            String name = child.getName();
            boolean isDir = child.isDirectory();
            String relativePath = FileHandler.getRelativePath(child, basePath);

            if (shouldSkipInSearch(name, isDir, relativePath, ignoreMatcher)) {
                continue;
            }

            JsonObject fileObj = FileHandler.createFileObject(child, name, relativePath);
            files.add(fileObj);
            added++;
        }
    }

    /**
     * Recursively collect files.
     */
    private void collectFilesRecursive(File dir, String basePath, List<JsonObject> files, FileHandler.FileListRequest request, int depth, IgnoreRuleMatcher ignoreMatcher) {
        if (depth > MAX_SEARCH_DEPTH || files.size() >= MAX_SEARCH_RESULTS) return;
        if (!dir.isDirectory()) return;

        File[] children = dir.listFiles();

        if (children == null) return;

        for (File child : children) {
            if (files.size() >= MAX_SEARCH_RESULTS) break;

            String name = child.getName();
            boolean isDir = child.isDirectory();
            String relativePath = FileHandler.getRelativePath(child, basePath);

            if (shouldSkipInSearch(name, isDir, relativePath, ignoreMatcher)) {
                continue;
            }

            // Check if it matches the query
            boolean matches = true;
            if (request.hasQuery) {
                matches = request.matches(name, relativePath);
            }

            if (matches) {
                JsonObject fileObj = FileHandler.createFileObject(child, name, relativePath);
                files.add(fileObj);
            }

            // Directories are always searched recursively (child files may match even if the directory itself doesn't)
            if (isDir) {
                collectFilesRecursive(child, basePath, files, request, depth + 1, ignoreMatcher);
            }
        }
    }

    /**
     * Get or create ignore rule matcher.
     */
    private IgnoreRuleMatcher getOrCreateIgnoreMatcher(String basePath) {
        if (basePath == null) {
            return null;
        }

        File gitignoreFile = new File(basePath, ".gitignore");
        long currentLastModified = gitignoreFile.exists() ? gitignoreFile.lastModified() : 0;

        // Check if cache is valid
        boolean cacheValid = cachedIgnoreMatcher != null
                                     && basePath.equals(cachedIgnoreMatcherBasePath)
                                     && currentLastModified == cachedGitignoreLastModified;

        if (cacheValid) {
            return cachedIgnoreMatcher;
        }

        // Re-create matcher
        try {
            IgnoreRuleMatcher matcher = IgnoreRuleMatcher.forProject(basePath);
            LOG.debug("[FileHandler] Created IgnoreRuleMatcher with " + matcher.getRuleCount() + " rules for " + basePath);

            // Update cache
            cachedIgnoreMatcher = matcher;
            cachedIgnoreMatcherBasePath = basePath;
            cachedGitignoreLastModified = currentLastModified;

            return matcher;
        } catch (Exception e) {
            LOG.warn("[FileHandler] Failed to create IgnoreRuleMatcher: " + e.getMessage());
            return null;
        }
    }
}

package com.github.claudecodegui.handler;

import com.github.claudecodegui.util.IgnoreRuleMatcher;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 文件搜索辅助类
 * 封装文件系统搜索、过滤、路径处理等逻辑
 */
public class FileSearchHelper {

    private static final Logger LOG = Logger.getInstance(FileSearchHelper.class);

    // 常量定义
    public static final int MAX_SEARCH_RESULTS = 200;
    public static final int MAX_SEARCH_DEPTH = 15;
    public static final int MAX_DIRECTORY_CHILDREN = 100;

    // 始终跳过的目录（版本控制、包管理、构建缓存、IDE 配置等）
    public static final Set<String> ALWAYS_SKIP_DIRS = Set.of(
            // 版本控制
            ".git", ".svn", ".hg", ".bzr",
            // 包管理和依赖缓存
            "node_modules", "__pycache__", ".pnpm", "bower_components",
            // Java/JVM 构建缓存
            ".m2", ".gradle", ".ivy2", ".sbt", ".coursier",
            // 其他语言包管理缓存
            ".npm", ".yarn", ".pnpm-store", ".cargo", ".rustup",
            ".pub-cache", ".gem", ".bundle", ".composer", ".nuget",
            ".cache", ".local",
            // 构建输出目录
            "target", "build", "dist", "out", "output", "bin", "obj",
            // IDE 和编辑器配置
            ".idea", ".vscode", ".vs", ".eclipse", ".settings",
            // 虚拟环境
            "venv", ".venv", "env", ".env", "virtualenv",
            // 测试和覆盖率
            "coverage", ".nyc_output", ".pytest_cache", "__snapshots__",
            // 临时和日志
            "tmp", "temp", "logs", ".tmp", ".temp"
    );

    // 始终跳过的文件
    public static final Set<String> ALWAYS_SKIP_FILES = Set.of(
            ".DS_Store", "Thumbs.db", "desktop.ini"
    );

    // Ignore 规则匹配器缓存
    private IgnoreRuleMatcher cachedIgnoreMatcher = null;
    private String cachedIgnoreMatcherBasePath = null;
    private long cachedGitignoreLastModified = 0;

    /**
     * 列出目录的直接子文件/文件夹（不递归）
     */
    public void listDirectChildren(File dir, String basePath, List<JsonObject> files, IgnoreRuleMatcher ignoreMatcher) {
        if (!dir.isDirectory()) return;

        File[] children = dir.listFiles();
        if (children == null) return;

        int added = 0;
        for (File child : children) {
            if (added >= MAX_DIRECTORY_CHILDREN) break;

            String name = child.getName();
            boolean isDir = child.isDirectory();
            String relativePath = getRelativePath(child, basePath);

            if (shouldSkipInSearch(name, isDir, relativePath, ignoreMatcher)) {
                continue;
            }

            JsonObject fileObj = createFileObject(child, name, relativePath);
            files.add(fileObj);
            added++;
        }
    }

    /**
     * 递归收集文件
     */
    public void collectFilesRecursive(File dir, String basePath, List<JsonObject> files,
                                       FileListRequest request, int depth, IgnoreRuleMatcher ignoreMatcher) {
        if (depth > MAX_SEARCH_DEPTH || files.size() >= MAX_SEARCH_RESULTS) return;
        if (!dir.isDirectory()) return;

        File[] children = dir.listFiles();
        if (children == null) return;

        for (File child : children) {
            if (files.size() >= MAX_SEARCH_RESULTS) break;

            String name = child.getName();
            boolean isDir = child.isDirectory();
            String relativePath = getRelativePath(child, basePath);

            if (shouldSkipInSearch(name, isDir, relativePath, ignoreMatcher)) {
                continue;
            }

            // 检查是否匹配查询
            boolean matches = true;
            if (request.hasQuery) {
                matches = request.matches(name, relativePath);
            }

            if (matches) {
                JsonObject fileObj = createFileObject(child, name, relativePath);
                files.add(fileObj);
            }

            // 目录总是递归搜索（即使目录本身不匹配，其子文件可能匹配）
            if (isDir) {
                collectFilesRecursive(child, basePath, files, request, depth + 1, ignoreMatcher);
            }
        }
    }

    /**
     * 判断是否应该跳过文件或目录
     */
    public boolean shouldSkipInSearch(String name, boolean isDirectory) {
        if (isDirectory) {
            return ALWAYS_SKIP_DIRS.contains(name);
        }
        return ALWAYS_SKIP_FILES.contains(name);
    }

    /**
     * 判断是否应该跳过文件或目录（包含 .gitignore 规则检查）
     */
    public boolean shouldSkipInSearch(String name, boolean isDirectory, String relativePath, IgnoreRuleMatcher matcher) {
        // 首先检查硬编码的排除列表
        if (shouldSkipInSearch(name, isDirectory)) {
            return true;
        }

        // 然后检查 .gitignore 规则
        if (matcher != null && relativePath != null) {
            return matcher.isIgnored(relativePath, isDirectory);
        }

        return false;
    }

    /**
     * 获取或创建 Ignore 规则匹配器
     */
    public IgnoreRuleMatcher getOrCreateIgnoreMatcher(String basePath) {
        if (basePath == null) {
            return null;
        }

        File gitignoreFile = new File(basePath, ".gitignore");
        long currentLastModified = gitignoreFile.exists() ? gitignoreFile.lastModified() : 0;

        // 检查缓存是否有效
        boolean cacheValid = cachedIgnoreMatcher != null
                && basePath.equals(cachedIgnoreMatcherBasePath)
                && currentLastModified == cachedGitignoreLastModified;

        if (cacheValid) {
            return cachedIgnoreMatcher;
        }

        // 重新创建 matcher
        try {
            IgnoreRuleMatcher matcher = IgnoreRuleMatcher.forProject(basePath);
            LOG.debug("[FileSearchHelper] Created IgnoreRuleMatcher with " + matcher.getRuleCount() + " rules for " + basePath);

            // 更新缓存
            cachedIgnoreMatcher = matcher;
            cachedIgnoreMatcherBasePath = basePath;
            cachedGitignoreLastModified = currentLastModified;

            return matcher;
        } catch (Exception e) {
            LOG.warn("[FileSearchHelper] Failed to create IgnoreRuleMatcher: " + e.getMessage());
            return null;
        }
    }

    /**
     * 获取相对路径
     */
    public String getRelativePath(File file, String basePath) {
        String relativePath = file.getAbsolutePath().substring(basePath.length());
        if (relativePath.startsWith(File.separator)) {
            relativePath = relativePath.substring(1);
        }
        return relativePath.replace("\\", "/");
    }

    /**
     * 创建文件对象 (从 File)
     */
    public JsonObject createFileObject(File file, String name, String relativePath) {
        JsonObject fileObj = new JsonObject();
        fileObj.addProperty("name", name);
        fileObj.addProperty("path", relativePath);
        fileObj.addProperty("absolutePath", file.getAbsolutePath().replace("\\", "/"));
        fileObj.addProperty("type", file.isDirectory() ? "directory" : "file");

        if (file.isFile()) {
            int dotIndex = name.lastIndexOf('.');
            if (dotIndex > 0) {
                fileObj.addProperty("extension", name.substring(dotIndex + 1));
            }
        }
        return fileObj;
    }

    /**
     * 创建文件对象 (从 VirtualFile，避免物理 I/O)
     */
    public JsonObject createFileObject(VirtualFile file, String relativePath) {
        JsonObject fileObj = new JsonObject();
        String name = file.getName();
        fileObj.addProperty("name", name);
        fileObj.addProperty("path", relativePath);
        fileObj.addProperty("absolutePath", file.getPath()); // VirtualFile path uses /
        fileObj.addProperty("type", file.isDirectory() ? "directory" : "file");

        if (!file.isDirectory()) {
            String extension = file.getExtension();
            if (extension != null) {
                fileObj.addProperty("extension", extension);
            }
        }
        return fileObj;
    }

    /**
     * 文件列表请求封装
     */
    public static class FileListRequest {

        public final String query;
        public final String queryLower;
        public final String currentPath;
        public final boolean hasQuery;

        public FileListRequest(String query, String currentPath) {
            this.query = query != null ? query : "";
            this.queryLower = this.query.toLowerCase();
            this.currentPath = currentPath != null ? currentPath : "";
            this.hasQuery = !this.query.isEmpty();
        }

        public boolean matches(String name, String relativePath) {
            if (!hasQuery) return true;
            String lowerName = name.toLowerCase();
            String lowerPath = relativePath.toLowerCase();
            return (lowerName.contains(queryLower) || lowerPath.contains(queryLower));
        }
    }

    /**
     * 文件集合，自动处理路径归一化和去重
     */
    public static class FileSet {

        private final HashSet<String> paths = new HashSet<>();

        public boolean tryAdd(String path) {
            return paths.add(normalizePath(path));
        }

        public boolean contains(String path) {
            return paths.contains(normalizePath(path));
        }

        private String normalizePath(String path) {
            return path == null ? "" : path.replace('\\', '/');
        }
    }
}

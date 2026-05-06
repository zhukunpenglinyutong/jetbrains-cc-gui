package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.model.FileSortItem;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.progress.ProcessCanceledException;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * File related message handler.
 * Coordinates file listing, opening, and browser operations via dedicated sub-handlers.
 */
public class FileHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(FileHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "list_files",
        "open_file",
        "open_browser",
        "open_class",
        "get_linkify_capabilities"
    };

    private final OpenFileHandler openFileHandler;
    private final OpenClassHandler openClassHandler;
    private final OpenFileCollector openFileCollector;
    private final RecentFileCollector recentFileCollector;
    private final FileSystemCollector fileSystemCollector;
    private final RuntimeContextCollector runtimeContextCollector;

    public FileHandler(HandlerContext context) {
        super(context);
        this.openFileHandler = new OpenFileHandler(context);
        this.openClassHandler = new OpenClassHandler(context);
        this.openFileCollector = new OpenFileCollector(context);
        this.recentFileCollector = new RecentFileCollector(context);
        this.fileSystemCollector = new FileSystemCollector();
        this.runtimeContextCollector = new RuntimeContextCollector(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        return switch (type) {
            case "list_files" -> {
                handleListFiles(content);
                yield true;
            }
            case "open_file" -> {
                openFileHandler.handleOpenFile(content);
                yield true;
            }
            case "open_browser" -> {
                openFileHandler.handleOpenBrowser(content);
                yield true;
            }
            case "open_class" -> {
                openClassHandler.handleOpenClass(content);
                yield true;
            }
            case "get_linkify_capabilities" -> {
                sendLinkifyCapabilities();
                yield true;
            }
            default -> false;
        };
    }

    private void sendLinkifyCapabilities() {
        String capabilitiesJson = OpenClassHandler.buildCapabilitiesJson();
        ApplicationManager.getApplication().invokeLater(() ->
            callJavaScript("window.updateLinkifyCapabilities", escapeJs(capabilitiesJson))
        );
    }

    /**
     * Handle file list request.
     */
    private void handleListFiles(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                // 1. Parse request
                FileListRequest request = parseRequest(content);

                // 2. Get base path
                String basePath = getEffectiveBasePath();

                // 3. Initialize file set (deduplication)
                FileSet fileSet = new FileSet();

                // 4. Collect files
                List<JsonObject> files = new ArrayList<>();

                // Priority 0: Active Terminals
                runtimeContextCollector.collectTerminals(files, request);

                // Priority 0: Active Services
                runtimeContextCollector.collectServices(files, request);

                // Priority 1: Currently open files
                openFileCollector.collect(files, fileSet, basePath, request);

                // Priority 2: Recently opened files
                recentFileCollector.collect(files, fileSet, basePath, request);

                // Priority 3: File system scan
                fileSystemCollector.collect(files, fileSet, basePath, request);

                // 5. Sort
                sortFiles(files);

                // 6. Return result
                sendResult(files);
            } catch (ProcessCanceledException e) {
                throw e;
            } catch (Exception e) {
                LOG.error("[FileHandler] Failed to list files: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Send results back to the frontend.
     */
    private void sendResult(List<JsonObject> files) {
        Gson gson = new Gson();
        JsonObject result = new JsonObject();
        result.add("files", gson.toJsonTree(files));
        String resultJson = gson.toJson(result);

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.onFileListResult", escapeJs(resultJson));
        });
    }

    /**
     * Parse the request.
     */
    private FileListRequest parseRequest(String content) {
        if (content == null || content.isEmpty()) {
            return new FileListRequest("", "");
        }

        try {
            JsonObject json = new Gson().fromJson(content, JsonObject.class);
            String query = json.has("query") ? json.get("query").getAsString() : "";
            String currentPath = json.has("currentPath") ? json.get("currentPath").getAsString() : "";
            return new FileListRequest(query, currentPath);
        } catch (Exception e) {
            // If not JSON, treat as plain text query
            return new FileListRequest(content.trim(), "");
        }
    }

    /**
     * Get the effective base path.
     * Ensures a non-null path is always returned with proper fallback chain
     */
    private String getEffectiveBasePath() {
        if (context.getSession() != null) {
            String cwd = context.getSession().getCwd();
            if (cwd != null && !cwd.isEmpty()) {
                LOG.debug("[FileHandler] Using session cwd as base path: " + cwd);
                return cwd;
            }
        }

        if (context.getProject() != null) {
            String projectPath = context.getProject().getBasePath();
            if (projectPath != null) {
                LOG.debug("[FileHandler] Using project base path: " + projectPath);
                return projectPath;
            }
        }

        String userHome = PlatformUtils.getHomeDirectory();
        if (userHome != null && !userHome.isEmpty()) {
            LOG.debug("[FileHandler] Using user.home as base path: " + userHome);
            return userHome;
        }

        // Final fallback - should never happen but prevents null
        LOG.warn("[FileHandler] All base path sources failed, using current directory");
        return System.getProperty("user.dir", ".");
    }

    /**
     * Sort files.
     */
    private void sortFiles(List<JsonObject> files) {
        if (files.isEmpty()) return;

        // 1. Wrap as SortItem, pre-read/compute sorting fields
        List<FileSortItem> items = new ArrayList<>(files.size());
        for (JsonObject json : files) {
            items.add(new FileSortItem(json));
        }

        // 2. Sort
        items.sort((a, b) -> {
            // Priority 1 & 2: Keep original order (stability)
            if (a.priority < 3 && b.priority < 3) {
                return 0;
            }

            // Different priority: lower value comes first
            if (a.priority != b.priority) {
                return a.priority - b.priority;
            }

            // Priority 3+: Sort by depth -> parent -> type -> name
            int depthDiff = a.getDepth() - b.getDepth();
            if (depthDiff != 0) return depthDiff;

            int parentDiff = a.getParentPath().compareToIgnoreCase(b.getParentPath());
            if (parentDiff != 0) return parentDiff;

            if (a.isDir != b.isDir) {
                return a.isDir ? -1 : 1;
            }

            return a.name.compareToIgnoreCase(b.name);
        });

        // 3. Write back to original list
        files.clear();
        for (FileSortItem item : items) {
            files.add(item.json);
        }
    }

    // --- Static utility methods shared with collectors ---

    /**
     * Get relative path.
     */
    static String getRelativePath(File file, String basePath) {
        String relativePath = file.getAbsolutePath().substring(basePath.length());
        if (relativePath.startsWith(File.separator)) {
            relativePath = relativePath.substring(1);
        }
        return relativePath.replace("\\", "/");
    }

    /**
     * Create a file object.
     */
    static JsonObject createFileObject(File file, String name, String relativePath) {
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
     * Create a file object (from VirtualFile, avoiding physical I/O).
     */
    static JsonObject createFileObject(VirtualFile file, String relativePath) {
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
     * Add a VirtualFile to the list.
     */
    static void addVirtualFile(VirtualFile vf, String basePath, List<JsonObject> files, FileSet fileSet, FileListRequest request, int priority) {
        // Enhanced null safety checks
        if (vf == null || !vf.isValid() || vf.isDirectory()) return;
        if (basePath == null) {
            LOG.warn("[FileHandler] basePath is null in addVirtualFile, skipping file");
            return;
        }

        String name = vf.getName();
        if (FileSystemCollector.shouldSkipInSearch(name, false)) return;

        String path = vf.getPath();
        if (path == null) {
            LOG.warn("[FileHandler] VirtualFile path is null for: " + name);
            return;
        }
        if (!fileSet.tryAdd(path)) return;

        // Calculate relative path
        String relativePath = path;
        if (path.startsWith(basePath)) {
            relativePath = path.substring(basePath.length());
            if (relativePath.startsWith("/")) {
                relativePath = relativePath.substring(1);
            }
        }

        // Match query
        if (request.matches(name, relativePath)) {
            JsonObject obj = createFileObject(vf, relativePath);
            obj.addProperty("priority", priority);
            files.add(obj);
        }
    }

    // --- Internal helper classes ---

    /**
     * File list request wrapper.
     */
    static class FileListRequest {

        final String query;
        final String queryLower;
        final String currentPath;
        final boolean hasQuery;

        FileListRequest(String query, String currentPath) {
            this.query = query != null ? query : "";
            this.queryLower = this.query.toLowerCase();
            this.currentPath = currentPath != null ? currentPath : "";
            this.hasQuery = !this.query.isEmpty();
        }

        boolean matches(String name, String relativePath) {
            if (!hasQuery) return true;
            String lowerName = name.toLowerCase();
            String lowerPath = relativePath.toLowerCase();
            return (lowerName.contains(queryLower) || lowerPath.contains(queryLower));
        }
    }

    /**
     * File set that automatically handles path normalization and deduplication.
     */
    static class FileSet {

        private final HashSet<String> paths = new HashSet<>();

        boolean tryAdd(String path) {
            return paths.add(normalizePath(path));
        }

        boolean contains(String path) {
            return paths.contains(normalizePath(path));
        }

        private String normalizePath(String path) {
            return path == null ? "" : path.replace('\\', '/');
        }
    }
}

package com.github.claudecodegui.handler;

import com.github.claudecodegui.model.FileSortItem;
import com.github.claudecodegui.service.RunConfigMonitorService;
import com.github.claudecodegui.terminal.TerminalMonitorService;
import com.github.claudecodegui.util.EditorFileUtils;
import com.github.claudecodegui.util.IgnoreRuleMatcher;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.BrowserUtil;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.impl.EditorHistoryManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * File and command related message handler.
 */
public class FileHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(FileHandler.class);

    private static final String[] SUPPORTED_TYPES = {"list_files", "get_commands", "open_file", "open_browser",};

    // Constants
    private static final int MAX_RECENT_FILES = 50;
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

    // Ignore rule matcher cache
    private IgnoreRuleMatcher cachedIgnoreMatcher = null;
    private String cachedIgnoreMatcherBasePath = null;
    private long cachedGitignoreLastModified = 0;

    public FileHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "list_files":
                handleListFiles(content);
                return true;
            case "get_commands":
                handleGetCommands(content);
                return true;
            case "open_file":
                handleOpenFile(content);
                return true;
            case "open_browser":
                handleOpenBrowser(content);
                return true;
            default:
                return false;
        }
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
                collectActiveTerminals(files, request);
                
                // Priority 0: Active Services
                collectActiveServices(files, request);

                // Priority 1: Currently open files
                collectOpenFiles(files, fileSet, basePath, request);

                // Priority 2: Recently opened files
                collectRecentFiles(files, fileSet, basePath, request);

                // Priority 3: File system scan
                collectFileSystemFiles(files, fileSet, basePath, request);

                // 5. Sort
                sortFiles(files);

                // 6. Return result
                sendResult(files);
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
     * Collect currently open files.
     */
    private void collectOpenFiles(List<JsonObject> files, FileSet fileSet, String basePath, FileListRequest request) {
        ApplicationManager.getApplication().runReadAction(() -> {
            Project project = context.getProject();
            if (project == null || project.isDisposed()) {
                LOG.debug("[FileHandler] Project is null or disposed in collectOpenFiles");
                return;
            }

            try {
                // Double-check project state inside read action
                if (project.isDisposed()) {
                    LOG.debug("[FileHandler] Project disposed during collectOpenFiles");
                    return;
                }

                VirtualFile[] openFiles = FileEditorManager.getInstance(project).getOpenFiles();
                LOG.debug("[FileHandler] Collecting " + openFiles.length + " open files");

                for (VirtualFile vf : openFiles) {
                    addVirtualFile(vf, basePath, files, fileSet, request, 1);
                }
            } catch (Exception e) {
                LOG.warn("[FileHandler] Error collecting open files: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Collect recently opened files.
     */
    private void collectRecentFiles(List<JsonObject> files, FileSet fileSet, String basePath, FileListRequest request) {
        ApplicationManager.getApplication().runReadAction(() -> {
            Project project = context.getProject();
            if (project == null || project.isDisposed()) {
                LOG.debug("[FileHandler] Project is null or disposed in collectRecentFiles");
                return;
            }

            try {
                // Double-check project state inside read action
                if (project.isDisposed()) {
                    LOG.debug("[FileHandler] Project disposed during collectRecentFiles");
                    return;
                }

                List<VirtualFile> recentFiles = EditorHistoryManager.getInstance(project).getFileList();
                if (recentFiles == null) {
                    LOG.warn("[FileHandler] EditorHistoryManager returned null file list");
                    return;
                }

                LOG.debug("[FileHandler] Collecting up to " + MAX_RECENT_FILES + " recent files from " + recentFiles.size() + " total");

                // Iterate in reverse order to get the most recent files
                int count = 0;
                for (int i = recentFiles.size() - 1; i >= 0; i--) {
                    if (count >= MAX_RECENT_FILES) {
                        break;
                    }
                    VirtualFile vf = recentFiles.get(i);
                    if (vf != null) {
                        addVirtualFile(vf, basePath, files, fileSet, request, 2);
                        count++;
                    }
                }
            } catch (Throwable t) {
                LOG.warn("[FileHandler] Failed to get recent files: " + t.getMessage(), t);
            }
        });
    }

    /**
     * Collect files from the file system.
     */
    private void collectFileSystemFiles(List<JsonObject> files, FileSet fileSet, String basePath, FileListRequest request) {
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
     * Collect active services (Run/Debug configurations).
     */
    private void collectActiveServices(List<JsonObject> files, FileListRequest request) {
        ApplicationManager.getApplication().runReadAction(() -> {
            Project project = context.getProject();
            if (project == null || project.isDisposed()) return;

            try {
                List<RunConfigMonitorService.RunConfigInfo> configs = RunConfigMonitorService.getRunConfigurations(project);
                for (RunConfigMonitorService.RunConfigInfo config : configs) {
                    String displayName = config.getDisplayName();
                    String title = "Service: " + displayName;
                    
                    // Create safe name for the path (replace spaces with _, remove special chars)
                    String safeName = displayName.replace(" ", "_").replaceAll("[^a-zA-Z0-9_]", "");
                    String path = "service://" + safeName;

                    if (request.matches(title, path)) {
                        JsonObject serviceObj = new JsonObject();
                        serviceObj.addProperty("name", title);
                        serviceObj.addProperty("path", path);
                        serviceObj.addProperty("absolutePath", path); // Tag used in UI
                        serviceObj.addProperty("type", "service");
                        serviceObj.addProperty("priority", 0); // High priority
                        files.add(serviceObj);
                    }
                }
            } catch (Throwable t) {
                LOG.warn("[FileHandler] Failed to collect services: " + t.getMessage());
            }
        });
    }

    /**
     * Collect active terminals.
     */
    private void collectActiveTerminals(List<JsonObject> files, FileListRequest request) {
        ApplicationManager.getApplication().runReadAction(() -> {
            Project project = context.getProject();
            if (project == null || project.isDisposed()) return;

            try {
                List<Object> widgets = TerminalMonitorService.getWidgets(project);
                Map<String, Integer> nameCounts = new HashMap<>();
                
                for (Object widget : widgets) {
                    String baseTitle = TerminalMonitorService.getWidgetTitle(widget);
                    int count = nameCounts.getOrDefault(baseTitle, 0) + 1;
                    nameCounts.put(baseTitle, count);
                    
                    String titleText = baseTitle;
                    if (count > 1) {
                        titleText = baseTitle + " (" + count + ")";
                    }
                    
                    String title = "Terminal: " + titleText;
                    String safeName = titleText.replace(" ", "_").replaceAll("[^a-zA-Z0-9_]", "");
                    String path = "terminal://" + safeName;

                    if (request.matches(title, path)) {
                        JsonObject term = new JsonObject();
                        term.addProperty("name", title);
                        term.addProperty("path", path);
                        term.addProperty("absolutePath", path);
                        term.addProperty("type", "terminal");
                        term.addProperty("priority", 0); // High priority
                        files.add(term);
                    }
                }
            } catch (Throwable t) {
                LOG.warn("[FileHandler] Failed to collect terminals: " + t.getMessage());
            }
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

        String userHome = System.getProperty("user.home");
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

    /**
     * Handle get command list request.
     * Calls ClaudeSDKBridge to get the real SDK slash command list.
     */
    private void handleGetCommands(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                String query = "";
                if (content != null && !content.isEmpty()) {
                    try {
                        Gson gson = new Gson();
                        JsonObject json = gson.fromJson(content, JsonObject.class);
                        if (json.has("query")) {
                            query = json.get("query").getAsString();
                        }
                    } catch (Exception e) {
                        query = content;
                    }
                }

                // Get working directory
                String cwd = getEffectiveBasePath();

                LOG.info("[FileHandler] Getting slash commands from SDK, cwd=" + cwd);

                // Call ClaudeSDKBridge to get the real slash commands
                final String finalQuery = query;
                context.getClaudeSDKBridge().getSlashCommands(cwd).thenAccept(sdkCommands -> {
                    try {
                        Gson gson = new Gson();
                        List<JsonObject> commands = new ArrayList<>();

                        // Convert SDK returned command format
                        for (JsonObject cmd : sdkCommands) {
                            String name = cmd.has("name") ? cmd.get("name").getAsString() : "";
                            String description = cmd.has("description") ? cmd.get("description").getAsString() : "";

                            // Ensure command starts with /
                            String label = name.startsWith("/") ? name : "/" + name;

                            // Apply filter
                            if (finalQuery.isEmpty() || label.toLowerCase().contains(finalQuery.toLowerCase()) || description.toLowerCase().contains(finalQuery.toLowerCase())) {
                                JsonObject cmdObj = new JsonObject();
                                cmdObj.addProperty("label", label);
                                cmdObj.addProperty("description", description);
                                commands.add(cmdObj);
                            }
                        }

                        LOG.info("[FileHandler] Got " + commands.size() + " commands from SDK (filtered from " + sdkCommands.size() + ")");

                        // If SDK returned no commands, use local default commands as fallback
                        if (commands.isEmpty() && sdkCommands.isEmpty()) {
                            LOG.info("[FileHandler] SDK returned no commands, using local fallback");
                            addFallbackCommands(commands, finalQuery);
                        }

                        JsonObject result = new JsonObject();
                        result.add("commands", gson.toJsonTree(commands));
                        String resultJson = gson.toJson(result);

                        ApplicationManager.getApplication().invokeLater(() -> {
                            String js = "if (window.onCommandListResult) { window.onCommandListResult('" + escapeJs(resultJson) + "'); }";
                            context.executeJavaScriptOnEDT(js);
                        });
                    } catch (Exception e) {
                        LOG.error("[FileHandler] Failed to process SDK commands: " + e.getMessage(), e);
                    }
                }).exceptionally(ex -> {
                    LOG.error("[FileHandler] Failed to get commands from SDK: " + ex.getMessage());
                    // Use local default commands on error
                    try {
                        Gson gson = new Gson();
                        List<JsonObject> commands = new ArrayList<>();
                        addFallbackCommands(commands, finalQuery);

                        JsonObject result = new JsonObject();
                        result.add("commands", gson.toJsonTree(commands));
                        String resultJson = gson.toJson(result);

                        ApplicationManager.getApplication().invokeLater(() -> {
                            String js = "if (window.onCommandListResult) { window.onCommandListResult('" + escapeJs(resultJson) + "'); }";
                            context.executeJavaScriptOnEDT(js);
                        });
                    } catch (Exception e) {
                        LOG.error("[FileHandler] Failed to send fallback commands: " + e.getMessage(), e);
                    }
                    return null;
                });
            } catch (Exception e) {
                LOG.error("[FileHandler] Failed to get commands: " + e.getMessage(), e);
            }
        });
    }

    private void addFallbackCommands(List<JsonObject> commands, String query) {
        addCommand(commands, "/help", "显示帮助信息", query);
        addCommand(commands, "/clear", "清空对话历史", query);
        addCommand(commands, "/history", "查看历史记录", query);
        addCommand(commands, "/model", "切换模型", query);
        addCommand(commands, "/compact", "压缩对话上下文", query);
        addCommand(commands, "/init", "初始化项目配置", query);
        addCommand(commands, "/review", "代码审查", query);
    }

    /**
     * Open a file in the editor.
     * Supports file paths with line numbers: file.txt:100 or file.txt:100-200.
     */
    private void handleOpenFile(String filePath) {
        LOG.info("请求打开文件: " + filePath);

        // First process file path parsing on a regular thread (no VFS operations involved)
        CompletableFuture.runAsync(() -> {
            try {
                // Parse file path and line number
                final String[] parsedPath = {filePath};
                final int[] parsedLineNumber = {-1};

                // Detect and extract line number (format: file.txt:100 or file.txt:100-200)
                int colonIndex = filePath.lastIndexOf(':');
                if (colonIndex > 0) {
                    String afterColon = filePath.substring(colonIndex + 1);
                    // Check if after the colon is a line number (may include a range, e.g. 100-200)
                    if (afterColon.matches("\\d+(-\\d+)?")) {
                        parsedPath[0] = filePath.substring(0, colonIndex);
                        // Extract start line number
                        int dashIndex = afterColon.indexOf('-');
                        String lineStr = dashIndex > 0 ? afterColon.substring(0, dashIndex) : afterColon;
                        try {
                            parsedLineNumber[0] = Integer.parseInt(lineStr);
                            LOG.info("检测到行号: " + parsedLineNumber[0]);
                        } catch (NumberFormatException e) {
                            LOG.warn("解析行号失败: " + lineStr);
                        }
                    }
                }

                final String actualPath = parsedPath[0];
                final int lineNumber = parsedLineNumber[0];

                File file = new File(actualPath);

                // If file does not exist and is a relative path, try resolving relative to the project root
                if (!file.exists() && !file.isAbsolute() && context.getProject().getBasePath() != null) {
                    File projectFile = new File(context.getProject().getBasePath(), actualPath);
                    LOG.info("尝试相对于项目根目录解析: " + projectFile.getAbsolutePath());
                    if (projectFile.exists()) {
                        file = projectFile;
                    }
                }

                if (!file.exists()) {
                    LOG.warn("文件不存在: " + actualPath);
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("addErrorMessage", escapeJs("无法打开文件: 当前文件不存在 (" + actualPath + ")"));
                    }, ModalityState.nonModal());
                    return;
                }

                final File finalFile = file;

                // Use utility method to asynchronously refresh and find the file
                EditorFileUtils.refreshAndFindFileAsync(finalFile, virtualFile -> {
                    // File found successfully, open in editor
                    FileEditorManager.getInstance(context.getProject()).openFile(virtualFile, true);

                    // If a line number is present, navigate to the specified line
                    if (lineNumber > 0) {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            com.intellij.openapi.editor.Editor editor = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(context.getProject()).getSelectedTextEditor();
                            if (editor != null && editor.getDocument().getTextLength() > 0) {
                                // Line numbers are 0-based internally, user input is 1-based
                                int zeroBasedLine = Math.max(0, lineNumber - 1);
                                int lineCount = editor.getDocument().getLineCount();
                                if (zeroBasedLine < lineCount) {
                                    int offset = editor.getDocument().getLineStartOffset(zeroBasedLine);
                                    editor.getCaretModel().moveToOffset(offset);
                                    editor.getScrollingModel().scrollToCaret(com.intellij.openapi.editor.ScrollType.CENTER);
                                    LOG.info("跳转到第 " + lineNumber + " 行");
                                } else {
                                    LOG.warn("行号 " + lineNumber + " 超出范围（文件共 " + lineCount + " 行）");
                                }
                            }
                        }, ModalityState.nonModal());
                    }

                    LOG.info("成功打开文件: " + filePath);
                }, () -> {
                    // Failure callback
                    LOG.error("最终无法获取 VirtualFile: " + filePath);
                    callJavaScript("addErrorMessage", escapeJs("无法打开文件: " + filePath));
                });
            } catch (Exception e) {
                LOG.error("打开文件失败: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Open the browser.
     */
    private void handleOpenBrowser(String url) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                BrowserUtil.browse(url);
            } catch (Exception e) {
                LOG.error("无法打开浏览器: " + e.getMessage(), e);
            }
        });
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
     * Recursively collect files.
     */
    private void collectFilesRecursive(File dir, String basePath, List<JsonObject> files, FileListRequest request, int depth, IgnoreRuleMatcher ignoreMatcher) {
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

            // Check if it matches the query
            boolean matches = true;
            if (request.hasQuery) {
                matches = request.matches(name, relativePath);
            }

            if (matches) {
                JsonObject fileObj = createFileObject(child, name, relativePath);
                files.add(fileObj);
            }

            // Directories are always searched recursively (child files may match even if the directory itself doesn't)
            if (isDir) {
                collectFilesRecursive(child, basePath, files, request, depth + 1, ignoreMatcher);
            }
        }
    }

    /**
     * Determine whether to skip a file or directory (basic version, checks hardcoded lists only).
     */
    private boolean shouldSkipInSearch(String name, boolean isDirectory) {
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

    /**
     * Get relative path.
     */
    private String getRelativePath(File file, String basePath) {
        String relativePath = file.getAbsolutePath().substring(basePath.length());
        if (relativePath.startsWith(File.separator)) {
            relativePath = relativePath.substring(1);
        }
        return relativePath.replace("\\", "/");
    }

    /**
     * Create a file object.
     */
    private JsonObject createFileObject(File file, String name, String relativePath) {
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
    private JsonObject createFileObject(VirtualFile file, String relativePath) {
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
     * Add a command to the list.
     */
    private void addCommand(List<JsonObject> commands, String label, String description, String query) {
        if (query.isEmpty() || label.toLowerCase().contains(query.toLowerCase()) || description.toLowerCase().contains(query.toLowerCase())) {
            JsonObject cmd = new JsonObject();
            cmd.addProperty("label", label);
            cmd.addProperty("description", description);
            commands.add(cmd);
        }
    }

    /**
     * Add a VirtualFile to the list.
     */
    private void addVirtualFile(VirtualFile vf, String basePath, List<JsonObject> files, FileSet fileSet, FileListRequest request, int priority) {
        // Enhanced null safety checks
        if (vf == null || !vf.isValid() || vf.isDirectory()) return;
        if (basePath == null) {
            LOG.warn("[FileHandler] basePath is null in addVirtualFile, skipping file");
            return;
        }

        String name = vf.getName();
        if (shouldSkipInSearch(name, false)) return;

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
    private static class FileListRequest {

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
    private static class FileSet {

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

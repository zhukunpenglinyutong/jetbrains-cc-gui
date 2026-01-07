package com.github.claudecodegui.handler;

import com.github.claudecodegui.model.FileSortItem;
import com.github.claudecodegui.util.EditorFileUtils;
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
import java.util.HashSet;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * 文件和命令相关消息处理器
 */
public class FileHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(FileHandler.class);

    private static final String[] SUPPORTED_TYPES = {"list_files", "get_commands", "open_file", "open_browser",};

    // 常量定义
    private static final int MAX_RECENT_FILES = 50;
    private static final int MAX_SEARCH_RESULTS = 200;
    private static final int MAX_SEARCH_DEPTH = 15;
    private static final int MAX_DIRECTORY_CHILDREN = 100;

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
     * 处理文件列表请求
     */
    private void handleListFiles(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                // 1. 解析请求
                FileListRequest request = parseRequest(content);

                // 2. 获取基础路径
                String basePath = getEffectiveBasePath();

                // 3. 初始化文件集合（去重）
                FileSet fileSet = new FileSet();

                // 4. 收集文件
                List<JsonObject> files = new ArrayList<>();

                // Priority 1: 当前打开的文件
                collectOpenFiles(files, fileSet, basePath, request);

                // Priority 2: 最近打开的文件
                collectRecentFiles(files, fileSet, basePath, request);

                // Priority 3: 文件系统扫描
                collectFileSystemFiles(files, fileSet, basePath, request);

                // 5. 排序
                sortFiles(files);

                // 6. 返回结果
                sendResult(files);
            } catch (Exception e) {
                LOG.error("[FileHandler] Failed to list files: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 发送结果回前端
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
     * 收集当前打开的文件
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
     * 收集最近打开的文件
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

                // 倒序遍历，取最近的文件
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
     * 收集文件系统文件
     */
    private void collectFileSystemFiles(List<JsonObject> files, FileSet fileSet, String basePath, FileListRequest request) {
        List<JsonObject> diskFiles = new ArrayList<>();

        if (request.hasQuery) {
            File baseDir = new File(basePath);
            collectFilesRecursive(baseDir, basePath, diskFiles, request, 0);
        } else {
            File targetDir = new File(basePath, request.currentPath);
            if (targetDir.exists() && targetDir.isDirectory()) {
                listDirectChildren(targetDir, basePath, diskFiles);
            }
        }

        // 合并磁盘扫描结果
        for (JsonObject fileObj : diskFiles) {
            String absPath = fileObj.get("absolutePath").getAsString();
            if (fileSet.tryAdd(absPath)) {
                fileObj.addProperty("priority", 3);
                files.add(fileObj);
            }
        }
    }

    /**
     * 解析请求
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
            // 如果不是 JSON，当作纯文本 query
            return new FileListRequest(content.trim(), "");
        }
    }

    /**
     * 获取有效的基础路径
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
     * 文件排序
     */
    private void sortFiles(List<JsonObject> files) {
        if (files.isEmpty()) return;

        // 1. 包装为 SortItem，预读取/计算排序字段
        List<FileSortItem> items = new ArrayList<>(files.size());
        for (JsonObject json : files) {
            items.add(new FileSortItem(json));
        }

        // 2. 排序
        items.sort((a, b) -> {
            // Priority 1 & 2: 保持原始顺序 (稳定性)
            if (a.priority < 3 && b.priority < 3) {
                return 0;
            }

            // Priority 不同：数值小的在前
            if (a.priority != b.priority) {
                return a.priority - b.priority;
            }

            // Priority 3+: 按 depth → parent → type → name 排序
            int depthDiff = a.getDepth() - b.getDepth();
            if (depthDiff != 0) return depthDiff;

            int parentDiff = a.getParentPath().compareToIgnoreCase(b.getParentPath());
            if (parentDiff != 0) return parentDiff;

            if (a.isDir != b.isDir) {
                return a.isDir ? -1 : 1;
            }

            return a.name.compareToIgnoreCase(b.name);
        });

        // 3. 重写回原列表
        files.clear();
        for (FileSortItem item : items) {
            files.add(item.json);
        }
    }

    /**
     * 处理获取命令列表请求
     * 调用 ClaudeSDKBridge 获取真实的 SDK 斜杠命令列表
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

                // 获取工作目录
                String cwd = getEffectiveBasePath();

                LOG.info("[FileHandler] Getting slash commands from SDK, cwd=" + cwd);

                // 调用 ClaudeSDKBridge 获取真实的斜杠命令
                final String finalQuery = query;
                context.getClaudeSDKBridge().getSlashCommands(cwd).thenAccept(sdkCommands -> {
                    try {
                        Gson gson = new Gson();
                        List<JsonObject> commands = new ArrayList<>();

                        // 转换 SDK 返回的命令格式
                        for (JsonObject cmd : sdkCommands) {
                            String name = cmd.has("name") ? cmd.get("name").getAsString() : "";
                            String description = cmd.has("description") ? cmd.get("description").getAsString() : "";

                            // 确保命令以 / 开头
                            String label = name.startsWith("/") ? name : "/" + name;

                            // 应用过滤
                            if (finalQuery.isEmpty() || label.toLowerCase().contains(finalQuery.toLowerCase()) || description.toLowerCase().contains(finalQuery.toLowerCase())) {
                                JsonObject cmdObj = new JsonObject();
                                cmdObj.addProperty("label", label);
                                cmdObj.addProperty("description", description);
                                commands.add(cmdObj);
                            }
                        }

                        LOG.info("[FileHandler] Got " + commands.size() + " commands from SDK (filtered from " + sdkCommands.size() + ")");

                        // 如果 SDK 没有返回命令，使用本地默认命令作为回退
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
                    // 出错时使用本地默认命令
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
     * 在编辑器中打开文件
     */
    /**
     * 在编辑器中打开文件
     * 支持带行号的文件路径格式：file.txt:100 或 file.txt:100-200
     */
    private void handleOpenFile(String filePath) {
        LOG.info("请求打开文件: " + filePath);

        // 先在普通线程中处理文件路径解析（不涉及 VFS 操作）
        CompletableFuture.runAsync(() -> {
            try {
                // 解析文件路径和行号
                final String[] parsedPath = {filePath};
                final int[] parsedLineNumber = {-1};

                // 检测并提取行号（格式：file.txt:100 或 file.txt:100-200）
                int colonIndex = filePath.lastIndexOf(':');
                if (colonIndex > 0) {
                    String afterColon = filePath.substring(colonIndex + 1);
                    // 检查冒号后是否为行号（可能包含范围，如 100-200）
                    if (afterColon.matches("\\d+(-\\d+)?")) {
                        parsedPath[0] = filePath.substring(0, colonIndex);
                        // 提取起始行号
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

                // 如果文件不存在且是相对路径，尝试相对于项目根目录解析
                if (!file.exists() && !file.isAbsolute() && context.getProject().getBasePath() != null) {
                    File projectFile = new File(context.getProject().getBasePath(), actualPath);
                    LOG.info("尝试相对于项目根目录解析: " + projectFile.getAbsolutePath());
                    if (projectFile.exists()) {
                        file = projectFile;
                    }
                }

                if (!file.exists()) {
                    LOG.error("文件不存在: " + actualPath);
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("addErrorMessage", escapeJs("无法打开文件: 文件不存在 (" + actualPath + ")"));
                    }, ModalityState.nonModal());
                    return;
                }

                final File finalFile = file;

                // 使用工具类方法异步刷新并查找文件
                EditorFileUtils.refreshAndFindFileAsync(finalFile, virtualFile -> {
                    // 成功找到文件，在编辑器中打开
                    FileEditorManager.getInstance(context.getProject()).openFile(virtualFile, true);

                    // 如果有行号，跳转到指定行
                    if (lineNumber > 0) {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            com.intellij.openapi.editor.Editor editor = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(context.getProject()).getSelectedTextEditor();
                            if (editor != null && editor.getDocument().getTextLength() > 0) {
                                // 行号从 0 开始，用户输入从 1 开始
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
                    // 失败回调
                    LOG.error("最终无法获取 VirtualFile: " + filePath);
                    callJavaScript("addErrorMessage", escapeJs("无法打开文件: " + filePath));
                });
            } catch (Exception e) {
                LOG.error("打开文件失败: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 打开浏览器
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
     * 列出目录的直接子文件/文件夹（不递归）
     */
    private void listDirectChildren(File dir, String basePath, List<JsonObject> files) {
        if (!dir.isDirectory()) return;

        File[] children = dir.listFiles();
        if (children == null) return;

        int added = 0;
        for (File child : children) {
            if (added >= MAX_DIRECTORY_CHILDREN) break;

            String name = child.getName();
            boolean isDir = child.isDirectory();

            if (shouldSkipInSearch(name, isDir)) {
                continue;
            }

            String relativePath = getRelativePath(child, basePath);
            JsonObject fileObj = createFileObject(child, name, relativePath);
            files.add(fileObj);
            added++;
        }
    }

    /**
     * 递归收集文件
     */
    private void collectFilesRecursive(File dir, String basePath, List<JsonObject> files, FileListRequest request, int depth) {
        if (depth > MAX_SEARCH_DEPTH || files.size() >= MAX_SEARCH_RESULTS) return;
        if (!dir.isDirectory()) return;

        File[] children = dir.listFiles();

        if (children == null) return;

        for (File child : children) {
            if (files.size() >= MAX_SEARCH_RESULTS) break;

            String name = child.getName();
            boolean isDir = child.isDirectory();

            if (shouldSkipInSearch(name, isDir)) {
                continue;
            }

            String relativePath = getRelativePath(child, basePath);

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
                collectFilesRecursive(child, basePath, files, request, depth + 1);
            }
        }
    }

    /**
     * 判断是否应该跳过文件或目录
     */
    private boolean shouldSkipInSearch(String name, boolean isDirectory) {
        // 通用跳过
        if (name.equals(".git") || name.equals(".svn") || name.equals(".hg")) {
            return true;
        }
        if (name.equals("node_modules") || name.equals("__pycache__")) {
            return true;
        }

        // 目录特有
        if (isDirectory) {
            return (name.equals("target") || name.equals("build") || name.equals("dist") || name.equals("out"));
        }

        // 文件特有
        return name.equals(".DS_Store") || name.equals(".idea");
    }

    /**
     * 获取相对路径
     */
    private String getRelativePath(File file, String basePath) {
        String relativePath = file.getAbsolutePath().substring(basePath.length());
        if (relativePath.startsWith(File.separator)) {
            relativePath = relativePath.substring(1);
        }
        return relativePath.replace("\\", "/");
    }

    /**
     * 创建文件对象
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
     * 创建文件对象 (从 VirtualFile，避免物理 I/O)
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
     * 添加命令到列表
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
     * 添加 VirtualFile 到列表
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

        // 计算相对路径
        String relativePath = path;
        if (path.startsWith(basePath)) {
            relativePath = path.substring(basePath.length());
            if (relativePath.startsWith("/")) {
                relativePath = relativePath.substring(1);
            }
        }

        // 匹配查询
        if (request.matches(name, relativePath)) {
            JsonObject obj = createFileObject(vf, relativePath);
            obj.addProperty("priority", priority);
            files.add(obj);
        }
    }

    // --- 内部辅助类 ---

    /**
     * 文件列表请求封装
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
     * 文件集合，自动处理路径归一化和去重
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

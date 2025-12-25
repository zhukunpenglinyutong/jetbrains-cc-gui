package com.github.claudecodegui.handler;

import com.github.claudecodegui.util.EditorFileUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.BrowserUtil;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.search.FilenameIndex;
import com.intellij.psi.search.GlobalSearchScope;

import java.io.File;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * 文件和命令相关消息处理器
 */
public class FileHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(FileHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "list_files",
        "get_commands",
        "open_file",
        "open_browser",
        "get_open_tabs",
        "search_files",
        "open_file_chooser"
    };

    /**
     * 文件扩展名到 MIME 类型的映射表
     */
    private static final Map<String, String> MIME_TYPE_MAP = new HashMap<>();
    static {
        // 文本文件
        MIME_TYPE_MAP.put("txt", "text/plain");
        MIME_TYPE_MAP.put("md", "text/markdown");
        MIME_TYPE_MAP.put("html", "text/html");
        MIME_TYPE_MAP.put("css", "text/css");

        // 数据格式
        MIME_TYPE_MAP.put("json", "application/json");
        MIME_TYPE_MAP.put("xml", "application/xml");

        // 脚本语言
        MIME_TYPE_MAP.put("js", "application/javascript");
        MIME_TYPE_MAP.put("java", "text/x-java-source");
        MIME_TYPE_MAP.put("py", "text/x-python");

        // 文档
        MIME_TYPE_MAP.put("pdf", "application/pdf");

        // 图片
        MIME_TYPE_MAP.put("png", "image/png");
        MIME_TYPE_MAP.put("jpg", "image/jpeg");
        MIME_TYPE_MAP.put("jpeg", "image/jpeg");
        MIME_TYPE_MAP.put("gif", "image/gif");
        MIME_TYPE_MAP.put("svg", "image/svg+xml");
        MIME_TYPE_MAP.put("webp", "image/webp");
    }

    /**
     * 默认 MIME 类型
     */
    private static final String DEFAULT_MIME_TYPE = "application/octet-stream";

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
            case "get_open_tabs":
                handleGetOpenTabs(content);
                return true;
            case "search_files":
                handleSearchFiles(content);
                return true;
            case "open_file_chooser":
                handleOpenFileChooser(content);
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
                String query = "";
                String currentPath = "";

                if (content != null && !content.isEmpty()) {
                    try {
                        Gson gson = new Gson();
                        JsonObject json = gson.fromJson(content, JsonObject.class);
                        if (json.has("query")) {
                            query = json.get("query").getAsString();
                        }
                        if (json.has("currentPath")) {
                            currentPath = json.get("currentPath").getAsString();
                        }
                    } catch (Exception e) {
                        query = content;
                    }
                }

                // 优先使用当前会话的工作目录
                String basePath = context.getSession() != null &&
                                  context.getSession().getCwd() != null &&
                                  !context.getSession().getCwd().isEmpty()
                    ? context.getSession().getCwd()
                    : (context.getProject().getBasePath() != null ?
                       context.getProject().getBasePath() : System.getProperty("user.home"));

                List<JsonObject> files = new ArrayList<>();

                if (query != null && !query.isEmpty()) {
                    File baseDir = new File(basePath);
                    collectFiles(baseDir, basePath, files, query.toLowerCase(), 0, 15, 200);
                } else {
                    File targetDir = new File(basePath, currentPath);
                    if (targetDir.exists() && targetDir.isDirectory()) {
                        listDirectChildren(targetDir, basePath, files, 100);
                    }
                }

                // 排序
                sortFiles(files);

                Gson gson = new Gson();
                JsonObject result = new JsonObject();
                result.add("files", gson.toJsonTree(files));
                String resultJson = gson.toJson(result);

                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.onFileListResult", escapeJs(resultJson));
                });
            } catch (Exception e) {
                LOG.error("[FileHandler] Failed to list files: " + e.getMessage(), e);
            }
        });
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
                String cwd = context.getSession() != null &&
                             context.getSession().getCwd() != null &&
                             !context.getSession().getCwd().isEmpty()
                    ? context.getSession().getCwd()
                    : (context.getProject().getBasePath() != null ?
                       context.getProject().getBasePath() : System.getProperty("user.home"));

                LOG.info("[FileHandler] Getting slash commands from SDK, cwd=" + cwd);

                // 调用 ClaudeSDKBridge 获取真实的斜杠命令
                final String finalQuery = query;
                context.getClaudeSDKBridge().getSlashCommands(cwd)
                    .thenAccept(sdkCommands -> {
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
                                if (finalQuery.isEmpty() ||
                                    label.toLowerCase().contains(finalQuery.toLowerCase()) ||
                                    description.toLowerCase().contains(finalQuery.toLowerCase())) {
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
                                addCommand(commands, "/help", "显示帮助信息", finalQuery);
                                addCommand(commands, "/clear", "清空对话历史", finalQuery);
                                addCommand(commands, "/new", "创建新会话", finalQuery);
                                addCommand(commands, "/history", "查看历史记录", finalQuery);
                                addCommand(commands, "/model", "切换模型", finalQuery);
                                addCommand(commands, "/settings", "打开设置", finalQuery);
                                addCommand(commands, "/compact", "压缩对话上下文", finalQuery);
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
                    })
                    .exceptionally(ex -> {
                        LOG.error("[FileHandler] Failed to get commands from SDK: " + ex.getMessage());
                        // 出错时使用本地默认命令
                        try {
                            Gson gson = new Gson();
                            List<JsonObject> commands = new ArrayList<>();
                            addCommand(commands, "/help", "显示帮助信息", finalQuery);
                            addCommand(commands, "/clear", "清空对话历史", finalQuery);
                            addCommand(commands, "/new", "创建新会话", finalQuery);
                            addCommand(commands, "/history", "查看历史记录", finalQuery);
                            addCommand(commands, "/model", "切换模型", finalQuery);
                            addCommand(commands, "/settings", "打开设置", finalQuery);
                            addCommand(commands, "/compact", "压缩对话上下文", finalQuery);

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

    /**
     * 在编辑器中打开文件
     */
    private void handleOpenFile(String filePath) {
        LOG.info("请求打开文件: " + filePath);

        // 先在普通线程中处理文件路径解析（不涉及 VFS 操作）
        CompletableFuture.runAsync(() -> {
            try {
                File file = new File(filePath);

                // 如果文件不存在且是相对路径，尝试相对于项目根目录解析
                if (!file.exists() && !file.isAbsolute() && context.getProject().getBasePath() != null) {
                    File projectFile = new File(context.getProject().getBasePath(), filePath);
                    LOG.info("尝试相对于项目根目录解析: " + projectFile.getAbsolutePath());
                    if (projectFile.exists()) {
                        file = projectFile;
                    }
                }

                if (!file.exists()) {
                    LOG.error("文件不存在: " + filePath);
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("addErrorMessage", escapeJs("无法打开文件: 文件不存在 (" + filePath + ")"));
                    }, ModalityState.nonModal());
                    return;
                }

                final File finalFile = file;

                // 使用工具类方法异步刷新并查找文件
                EditorFileUtils.refreshAndFindFileAsync(
                        finalFile,
                        virtualFile -> {
                            // 成功找到文件，在编辑器中打开
                            FileEditorManager.getInstance(context.getProject()).openFile(virtualFile, true);
                            LOG.info("成功打开文件: " + filePath);
                        },
                        () -> {
                            // 失败回调
                            LOG.error("最终无法获取 VirtualFile: " + filePath);
                        callJavaScript("addErrorMessage", escapeJs("无法打开文件: " + filePath));
                    }
                );

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
    private void listDirectChildren(File dir, String basePath, List<JsonObject> files, int maxFiles) {
        if (!dir.isDirectory()) return;

        File[] children = dir.listFiles();
        if (children == null) return;

        int added = 0;
        for (File child : children) {
            if (added >= maxFiles) break;

            String name = child.getName();

            // 跳过常见的忽略目录和系统文件
            if (shouldSkipFile(name)) {
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
    private void collectFiles(File dir, String basePath, List<JsonObject> files,
                              String query, int depth, int maxDepth, int maxFiles) {
        if (depth > maxDepth || files.size() >= maxFiles) return;
        if (!dir.isDirectory()) return;

        File[] children = dir.listFiles();
        if (children == null) return;

        for (File child : children) {
            if (files.size() >= maxFiles) break;

            String name = child.getName();
            if (shouldSkipDirectory(name)) {
                continue;
            }

            String relativePath = getRelativePath(child, basePath);

            // 检查是否匹配查询
            if (!query.isEmpty()) {
                boolean matchesName = name.toLowerCase().contains(query);
                boolean matchesPath = relativePath.toLowerCase().contains(query);
                boolean matchesExtension = query.startsWith(".") && name.toLowerCase().endsWith(query);

                if (!matchesName && !matchesPath && !matchesExtension) {
                    if (child.isDirectory()) {
                        collectFiles(child, basePath, files, query, depth + 1, maxDepth, maxFiles);
                    }
                    continue;
                }
            }

            JsonObject fileObj = createFileObject(child, name, relativePath);
            files.add(fileObj);

            if (child.isDirectory()) {
                collectFiles(child, basePath, files, query, depth + 1, maxDepth, maxFiles);
            }
        }
    }

    /**
     * 判断是否应该跳过文件
     */
    private boolean shouldSkipFile(String name) {
        return name.equals(".git") ||
               name.equals(".svn") ||
               name.equals(".hg") ||
               name.equals("node_modules") ||
               name.equals("target") ||
               name.equals("build") ||
               name.equals("dist") ||
               name.equals("out") ||
               name.equals("__pycache__") ||
               name.equals(".DS_Store") ||
               name.equals(".idea");
    }

    /**
     * 判断是否应该跳过目录
     */
    private boolean shouldSkipDirectory(String name) {
        return name.equals(".git") ||
               name.equals(".svn") ||
               name.equals(".hg") ||
               name.equals("node_modules") ||
               name.equals("target") ||
               name.equals("build") ||
               name.equals("dist") ||
               name.equals("out") ||
               name.equals("__pycache__");
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
     * 添加命令到列表
     */
    private void addCommand(List<JsonObject> commands, String label, String description, String query) {
        if (query.isEmpty() ||
            label.toLowerCase().contains(query.toLowerCase()) ||
            description.toLowerCase().contains(query.toLowerCase())) {
            JsonObject cmd = new JsonObject();
            cmd.addProperty("label", label);
            cmd.addProperty("description", description);
            commands.add(cmd);
        }
    }

    /**
     * 文件排序
     */
    private void sortFiles(List<JsonObject> files) {
        files.sort((a, b) -> {
            String aPath = a.get("path").getAsString();
            String bPath = b.get("path").getAsString();
            boolean aDir = "directory".equals(a.get("type").getAsString());
            boolean bDir = "directory".equals(b.get("type").getAsString());
            String aName = a.get("name").getAsString();
            String bName = b.get("name").getAsString();

            int aDepth = aPath.split("/").length;
            int bDepth = bPath.split("/").length;

            if (aDepth != bDepth) return aDepth - bDepth;

            String aParent = aPath.contains("/") ? aPath.substring(0, aPath.lastIndexOf('/')) : "";
            String bParent = bPath.contains("/") ? bPath.substring(0, bPath.lastIndexOf('/')) : "";
            int parentCompare = aParent.compareToIgnoreCase(bParent);
            if (parentCompare != 0) return parentCompare;

            if (aDir != bDir) return aDir ? -1 : 1;

            return aName.compareToIgnoreCase(bName);
        });
    }

    /**
     * 处理获取打开的标签页请求
     */
    private void handleGetOpenTabs(String content) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                FileEditorManager fileEditorManager = FileEditorManager.getInstance(context.getProject());
                VirtualFile[] openFiles = fileEditorManager.getOpenFiles();

                List<JsonObject> tabs = new ArrayList<>();
                int count = 0;
                for (VirtualFile file : openFiles) {
                    if (count >= 5) break; // 最多5个

                    String relativePath = "";
                    if (context.getProject().getBasePath() != null) {
                        String basePath = context.getProject().getBasePath();
                        String filePath = file.getPath();
                        if (filePath.startsWith(basePath)) {
                            relativePath = filePath.substring(basePath.length());
                            if (relativePath.startsWith("/") || relativePath.startsWith("\\")) {
                                relativePath = relativePath.substring(1);
                            }
                        } else {
                            relativePath = file.getName();
                        }
                    } else {
                        relativePath = file.getName();
                    }

                    JsonObject tab = new JsonObject();
                    tab.addProperty("name", file.getName());
                    tab.addProperty("path", relativePath.replace("\\", "/"));
                    tab.addProperty("absolutePath", file.getPath().replace("\\", "/"));
                    tabs.add(tab);
                    count++;
                }

                Gson gson = new Gson();
                JsonObject response = new JsonObject();
                response.add("tabs", gson.toJsonTree(tabs));
                String resultJson = gson.toJson(response);

                callJavaScript("window.onOpenTabsResult", escapeJs(resultJson));
                LOG.info("[FileHandler] Sent " + tabs.size() + " open tabs to frontend");
            } catch (Exception e) {
                LOG.error("[FileHandler] Failed to get open tabs: " + e.getMessage(), e);
            }
        }, ModalityState.nonModal());
    }

    /**
     * 处理搜索文件请求
     */
    private void handleSearchFiles(String content) {
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

                if (query == null || query.trim().isEmpty()) {
                    // 空查询，返回空结果
                    Gson gson = new Gson();
                    JsonObject response = new JsonObject();
                    response.add("files", gson.toJsonTree(new ArrayList<>()));
                    String resultJson = gson.toJson(response);

                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.onFileSearchResult", escapeJs(resultJson));
                    });
                    return;
                }

                final String finalQuery = query.toLowerCase();
                LOG.info("[FileHandler] Searching files with query: " + finalQuery);

                // 在 read action 中执行文件搜索
                List<JsonObject> results = ApplicationManager.getApplication().runReadAction((com.intellij.openapi.util.Computable<List<JsonObject>>) () -> {
                    List<JsonObject> searchResults = new ArrayList<>();

                    try {
                        // 使用 IntelliJ 的文件搜索 API
                        GlobalSearchScope scope = GlobalSearchScope.projectScope(context.getProject());

                        // 先尝试精确匹配
                        Collection<VirtualFile> exactMatches = FilenameIndex.getVirtualFilesByName(
                            finalQuery,
                            scope
                        );

                        for (VirtualFile file : exactMatches) {
                            if (searchResults.size() >= 10) break;

                            String relativePath = "";
                            if (context.getProject().getBasePath() != null) {
                                String basePath = context.getProject().getBasePath();
                                String filePath = file.getPath();
                                if (filePath.startsWith(basePath)) {
                                    relativePath = filePath.substring(basePath.length());
                                    if (relativePath.startsWith("/") || relativePath.startsWith("\\")) {
                                        relativePath = relativePath.substring(1);
                                    }
                                } else {
                                    relativePath = file.getName();
                                }
                            } else {
                                relativePath = file.getName();
                            }

                            JsonObject fileObj = new JsonObject();
                            fileObj.addProperty("name", file.getName());
                            fileObj.addProperty("path", relativePath.replace("\\", "/"));
                            fileObj.addProperty("absolutePath", file.getPath().replace("\\", "/"));
                            fileObj.addProperty("type", file.isDirectory() ? "directory" : "file");

                            if (!file.isDirectory()) {
                                String extension = file.getExtension();
                                if (extension != null && !extension.isEmpty()) {
                                    fileObj.addProperty("extension", extension);
                                }
                            }

                            searchResults.add(fileObj);
                        }

                        // 如果精确匹配没有结果,尝试模糊搜索
                        if (searchResults.isEmpty()) {
                            // 获取项目中的所有文件名并进行模糊匹配
                            String[] allFileNames = FilenameIndex.getAllFilenames(context.getProject());
                            for (String fileName : allFileNames) {
                                if (searchResults.size() >= 10) break;
                                if (fileName.toLowerCase().contains(finalQuery)) {
                                    // 获取该文件名的所有文件
                                    Collection<VirtualFile> files = FilenameIndex.getVirtualFilesByName(
                                        fileName,
                                        scope
                                    );
                                    for (VirtualFile file : files) {
                                        if (searchResults.size() >= 10) break;

                                        String relativePath = "";
                                        if (context.getProject().getBasePath() != null) {
                                            String basePath = context.getProject().getBasePath();
                                            String filePath = file.getPath();
                                            if (filePath.startsWith(basePath)) {
                                                relativePath = filePath.substring(basePath.length());
                                                if (relativePath.startsWith("/") || relativePath.startsWith("\\")) {
                                                    relativePath = relativePath.substring(1);
                                                }
                                            } else {
                                                relativePath = file.getName();
                                            }
                                        } else {
                                            relativePath = file.getName();
                                        }

                                        JsonObject fileObj = new JsonObject();
                                        fileObj.addProperty("name", file.getName());
                                        fileObj.addProperty("path", relativePath.replace("\\", "/"));
                                        fileObj.addProperty("absolutePath", file.getPath().replace("\\", "/"));
                                        fileObj.addProperty("type", file.isDirectory() ? "directory" : "file");

                                        if (!file.isDirectory()) {
                                            String extension = file.getExtension();
                                            if (extension != null && !extension.isEmpty()) {
                                                fileObj.addProperty("extension", extension);
                                            }
                                        }

                                        searchResults.add(fileObj);
                                    }
                                }
                            }
                        }
                    } catch (Exception e) {
                        LOG.error("[FileHandler] Error during file search: " + e.getMessage(), e);
                    }

                    return searchResults;
                });

                Gson gson = new Gson();
                JsonObject response = new JsonObject();
                response.add("files", gson.toJsonTree(results));
                String resultJson = gson.toJson(response);

                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.onFileSearchResult", escapeJs(resultJson));
                    LOG.info("[FileHandler] Sent " + results.size() + " search results to frontend");
                });
            } catch (Exception e) {
                LOG.error("[FileHandler] Failed to search files: " + e.getMessage(), e);
                // 发送空结果
                try {
                    Gson gson = new Gson();
                    JsonObject response = new JsonObject();
                    response.add("files", gson.toJsonTree(new ArrayList<>()));
                    String resultJson = gson.toJson(response);

                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.onFileSearchResult", escapeJs(resultJson));
                    });
                } catch (Exception ex) {
                    LOG.error("[FileHandler] Failed to send empty search results: " + ex.getMessage(), ex);
                }
            }
        });
    }

    /**
     * 处理打开文件选择器请求
     */
    private void handleOpenFileChooser(String content) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                FileChooserDescriptor descriptor = FileChooserDescriptorFactory.createSingleFileDescriptor();
                descriptor.setTitle("选择文件");
                descriptor.setDescription("选择要添加为附件的文件");

                VirtualFile selectedFile = FileChooser.chooseFile(descriptor, context.getProject(), null);

                if (selectedFile != null) {
                    String filePath = selectedFile.getPath().replace("\\", "/");
                    LOG.info("[FileHandler] File selected for attachment: " + filePath);

                    // 读取文件内容并作为附件添加
                    try {
                        byte[] fileContent = selectedFile.contentsToByteArray();
                        String base64Content = java.util.Base64.getEncoder().encodeToString(fileContent);

                        // 构建附件 JSON
                        JsonObject attachment = new JsonObject();
                        attachment.addProperty("id", java.util.UUID.randomUUID().toString());
                        attachment.addProperty("fileName", selectedFile.getName());

                        // 确定 MIME 类型
                        String mimeType = DEFAULT_MIME_TYPE;
                        String extension = selectedFile.getExtension();
                        if (extension != null) {
                            mimeType = MIME_TYPE_MAP.getOrDefault(extension.toLowerCase(), DEFAULT_MIME_TYPE);
                        }

                        attachment.addProperty("mediaType", mimeType);
                        attachment.addProperty("data", base64Content);

                        Gson gson = new Gson();
                        String attachmentJson = gson.toJson(attachment);

                        // 调用前端方法添加附件
                        String js = "if (window.addAttachmentFromJava) { window.addAttachmentFromJava('" + escapeJs(attachmentJson) + "'); }";
                        context.executeJavaScriptOnEDT(js);

                        LOG.info("[FileHandler] File added as attachment: " + selectedFile.getName() + " (" + fileContent.length + " bytes)");
                    } catch (Exception e) {
                        LOG.error("[FileHandler] Failed to read file content: " + e.getMessage(), e);
                        callJavaScript("addErrorMessage", escapeJs("无法读取文件: " + e.getMessage()));
                    }
                } else {
                    LOG.info("[FileHandler] File chooser cancelled");
                }
            } catch (Exception e) {
                LOG.error("[FileHandler] Failed to open file chooser: " + e.getMessage(), e);
            }
        }, ModalityState.nonModal());
    }
}

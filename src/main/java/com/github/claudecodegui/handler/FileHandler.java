package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ide.BrowserUtil;
import com.intellij.util.concurrency.AppExecutorUtil;

import javax.swing.*;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * 文件和命令相关消息处理器
 */
public class FileHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {
        "list_files",
        "get_commands",
        "open_file",
        "open_browser"
    };

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

                SwingUtilities.invokeLater(() -> {
                    callJavaScript("window.onFileListResult", escapeJs(resultJson));
                });
            } catch (Exception e) {
                System.err.println("[FileHandler] Failed to list files: " + e.getMessage());
                e.printStackTrace();
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

                System.out.println("[FileHandler] Getting slash commands from SDK, cwd=" + cwd);

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

                            System.out.println("[FileHandler] Got " + commands.size() + " commands from SDK (filtered from " + sdkCommands.size() + ")");

                            // 如果 SDK 没有返回命令，使用本地默认命令作为回退
                            if (commands.isEmpty() && sdkCommands.isEmpty()) {
                                System.out.println("[FileHandler] SDK returned no commands, using local fallback");
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

                            SwingUtilities.invokeLater(() -> {
                                String js = "if (window.onCommandListResult) { window.onCommandListResult('" + escapeJs(resultJson) + "'); }";
                                context.executeJavaScriptOnEDT(js);
                            });
                        } catch (Exception e) {
                            System.err.println("[FileHandler] Failed to process SDK commands: " + e.getMessage());
                            e.printStackTrace();
                        }
                    })
                    .exceptionally(ex -> {
                        System.err.println("[FileHandler] Failed to get commands from SDK: " + ex.getMessage());
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

                            SwingUtilities.invokeLater(() -> {
                                String js = "if (window.onCommandListResult) { window.onCommandListResult('" + escapeJs(resultJson) + "'); }";
                                context.executeJavaScriptOnEDT(js);
                            });
                        } catch (Exception e) {
                            System.err.println("[FileHandler] Failed to send fallback commands: " + e.getMessage());
                        }
                        return null;
                    });

            } catch (Exception e) {
                System.err.println("[FileHandler] Failed to get commands: " + e.getMessage());
                e.printStackTrace();
            }
        });
    }

    /**
     * 在编辑器中打开文件
     */
    private void handleOpenFile(String filePath) {
        System.out.println("请求打开文件: " + filePath);

        // 先在普通线程中处理文件路径解析（不涉及 VFS 操作）
        CompletableFuture.runAsync(() -> {
            try {
                File file = new File(filePath);

                // 如果文件不存在且是相对路径，尝试相对于项目根目录解析
                if (!file.exists() && !file.isAbsolute() && context.getProject().getBasePath() != null) {
                    File projectFile = new File(context.getProject().getBasePath(), filePath);
                    System.out.println("尝试相对于项目根目录解析: " + projectFile.getAbsolutePath());
                    if (projectFile.exists()) {
                        file = projectFile;
                    }
                }

                if (!file.exists()) {
                    System.err.println("文件不存在: " + filePath);
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("addErrorMessage", escapeJs("无法打开文件: 文件不存在 (" + filePath + ")"));
                    }, ModalityState.nonModal());
                    return;
                }

                final File finalFile = file;

                // 使用 ReadAction.nonBlocking() 在后台线程中查找文件
                ReadAction
                    .nonBlocking(() -> {
                        // 在后台线程中查找文件（这是慢操作）
                        return LocalFileSystem.getInstance().findFileByIoFile(finalFile);
                    })
                    .finishOnUiThread(ModalityState.nonModal(), virtualFile -> {
                        // 在 UI 线程中打开文件
                        if (virtualFile == null) {
                            System.err.println("无法获取 VirtualFile: " + filePath);
                            return;
                        }

                        FileEditorManager.getInstance(context.getProject()).openFile(virtualFile, true);
                        System.out.println("成功打开文件: " + filePath);
                    })
                    .submit(AppExecutorUtil.getAppExecutorService());

            } catch (Exception e) {
                System.err.println("打开文件失败: " + e.getMessage());
                e.printStackTrace();
            }
        });
    }

    /**
     * 打开浏览器
     */
    private void handleOpenBrowser(String url) {
        SwingUtilities.invokeLater(() -> {
            try {
                BrowserUtil.browse(url);
            } catch (Exception e) {
                System.err.println("无法打开浏览器: " + e.getMessage());
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
}

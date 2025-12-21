package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.diff.DiffContentFactory;
import com.intellij.diff.DiffManager;
import com.intellij.diff.contents.DiffContent;
import com.intellij.diff.requests.SimpleDiffRequest;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileTypes.FileType;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Diff 和文件刷新相关消息处理器
 */
public class DiffHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(DiffHandler.class);
    private final Gson gson = new Gson();

    private static final String[] SUPPORTED_TYPES = {
        "refresh_file",
        "show_diff",
        "show_multi_edit_diff"
    };

    public DiffHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "refresh_file":
                handleRefreshFile(content);
                return true;
            case "show_diff":
                handleShowDiff(content);
                return true;
            case "show_multi_edit_diff":
                handleShowMultiEditDiff(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * 刷新文件到 IDEA
     * 使用异步方式和重试机制确保文件能被正确刷新
     */
    private void handleRefreshFile(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : null;

            if (filePath == null || filePath.isEmpty()) {
                LOG.warn("refresh_file: filePath is empty");
                return;
            }

            LOG.info("Refreshing file: " + filePath);

            // 在后台线程中处理文件刷新
            CompletableFuture.runAsync(() -> {
                try {
                    File file = new File(filePath);

                    // 添加短暂延迟，等待文件写入完成
                    try {
                        TimeUnit.MILLISECONDS.sleep(100);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }

                    // 如果文件不存在且是相对路径，尝试相对于项目根目录解析
                    if (!file.exists() && !file.isAbsolute() && context.getProject().getBasePath() != null) {
                        File projectFile = new File(context.getProject().getBasePath(), filePath);
                        if (projectFile.exists()) {
                            file = projectFile;
                        }
                    }

                    if (!file.exists()) {
                        LOG.warn("File does not exist: " + filePath);
                        return;
                    }

                    final File finalFile = file;
                    final String canonicalPath;
                    try {
                        canonicalPath = finalFile.getCanonicalPath();
                    } catch (Exception e) {
                        LOG.error("Failed to get canonical path: " + filePath, e);
                        return;
                    }

                    // 使用 ReadAction.nonBlocking() 在后台线程中查找文件
                    ReadAction
                        .nonBlocking(() -> {
                            // 先强制刷新本地文件系统
                            LocalFileSystem.getInstance().refreshAndFindFileByPath(canonicalPath);
                            // 再次查找文件
                            VirtualFile vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(canonicalPath);
                            if (vf == null) {
                                // 回退到使用 File 对象查找
                                vf = LocalFileSystem.getInstance().findFileByIoFile(finalFile);
                            }
                            return vf;
                        })
                        .finishOnUiThread(ModalityState.nonModal(), virtualFile -> {
                            // 在 UI 线程中执行刷新操作
                            if (virtualFile == null) {
                                LOG.warn("Could not find virtual file: " + filePath + ", retrying...");
                                // 重试：在 UI 线程中再次刷新并查找
                                VirtualFile retryVf = LocalFileSystem.getInstance().refreshAndFindFileByPath(canonicalPath);
                                if (retryVf != null) {
                                    performFileRefresh(retryVf, filePath);
                                } else {
                                    LOG.error("Failed to refresh file after retry: " + filePath);
                                }
                                return;
                            }

                            performFileRefresh(virtualFile, filePath);
                        })
                        .submit(AppExecutorUtil.getAppExecutorService());

                } catch (Exception e) {
                    LOG.error("Failed to refresh file: " + filePath, e);
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse refresh_file request: " + e.getMessage(), e);
        }
    }

    /**
     * 执行文件刷新操作（必须在 UI 线程中调用）
     */
    private void performFileRefresh(VirtualFile virtualFile, String filePath) {
        try {
            // 刷新文件内容
            virtualFile.refresh(false, false);

            // 如果文件已在编辑器中打开，重新加载
            FileDocumentManager.getInstance().reloadFiles(virtualFile);

            LOG.info("File refreshed successfully: " + filePath);
        } catch (Exception e) {
            LOG.error("Failed to perform file refresh: " + filePath, e);
        }
    }

    /**
     * 显示 Diff 视图
     */
    private void handleShowDiff(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            String oldContent = json.has("oldContent") ? json.get("oldContent").getAsString() : "";
            String newContent = json.has("newContent") ? json.get("newContent").getAsString() : "";
            String title = json.has("title") ? json.get("title").getAsString() : null;

            LOG.info("Showing diff for file: " + filePath);

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    String fileName = new File(filePath).getName();
                    FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);

                    // 创建 Diff 内容
                    DiffContent leftContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), oldContent, fileType);
                    DiffContent rightContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), newContent, fileType);

                    // 创建 Diff 请求
                    String diffTitle = title != null ? title : "文件变更: " + fileName;
                    SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                        diffTitle,
                        leftContent,
                        rightContent,
                        fileName + " (修改前)",
                        fileName + " (修改后)"
                    );

                    // 显示 Diff 窗口
                    DiffManager.getInstance().showDiff(context.getProject(), diffRequest);

                    LOG.info("Diff view opened for: " + filePath);
                } catch (Exception e) {
                    LOG.error("Failed to show diff: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse show_diff request: " + e.getMessage(), e);
        }
    }

    /**
     * 显示多处编辑的 Diff 视图
     */
    private void handleShowMultiEditDiff(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            JsonArray edits = json.has("edits") ? json.getAsJsonArray("edits") : new JsonArray();
            String currentContent = json.has("currentContent") ? json.get("currentContent").getAsString() : null;

            LOG.info("Showing multi-edit diff for file: " + filePath + " with " + edits.size() + " edits");

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    // 获取文件当前内容
                    String afterContent = currentContent;
                    if (afterContent == null) {
                        File file = new File(filePath);
                        if (file.exists()) {
                            VirtualFile virtualFile = LocalFileSystem.getInstance()
                                .refreshAndFindFileByPath(file.getCanonicalPath());
                            if (virtualFile != null) {
                                virtualFile.refresh(false, false);
                                afterContent = new String(virtualFile.contentsToByteArray(), StandardCharsets.UTF_8);
                            }
                        }
                    }

                    if (afterContent == null) {
                        LOG.warn("Could not read file content: " + filePath);
                        return;
                    }

                    // 反向重建编辑前内容
                    String beforeContent = rebuildBeforeContent(afterContent, edits);

                    String fileName = new File(filePath).getName();
                    FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);

                    // 创建 Diff 内容
                    DiffContent leftContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), beforeContent, fileType);
                    DiffContent rightContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), afterContent, fileType);

                    // 创建 Diff 请求
                    String diffTitle = "文件变更: " + fileName + " (" + edits.size() + " 处编辑)";
                    SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                        diffTitle,
                        leftContent,
                        rightContent,
                        fileName + " (修改前)",
                        fileName + " (修改后)"
                    );

                    // 显示 Diff 窗口
                    DiffManager.getInstance().showDiff(context.getProject(), diffRequest);

                    LOG.info("Multi-edit diff view opened for: " + filePath);
                } catch (Exception e) {
                    LOG.error("Failed to show multi-edit diff: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse show_multi_edit_diff request: " + e.getMessage(), e);
        }
    }

    /**
     * 反向重建编辑前内容
     * 通过反向应用编辑操作，从编辑后内容推导出编辑前内容
     */
    private String rebuildBeforeContent(String afterContent, JsonArray edits) {
        String content = afterContent;

        // 反向遍历编辑操作
        for (int i = edits.size() - 1; i >= 0; i--) {
            JsonObject edit = edits.get(i).getAsJsonObject();
            String oldString = edit.has("oldString") ? edit.get("oldString").getAsString() : "";
            String newString = edit.has("newString") ? edit.get("newString").getAsString() : "";
            boolean replaceAll = edit.has("replaceAll") && edit.get("replaceAll").getAsBoolean();

            if (replaceAll) {
                // 全局替换：newString → oldString
                content = content.replace(newString, oldString);
            } else {
                // 单次替换：找到第一个 newString，替换为 oldString
                int index = content.indexOf(newString);
                if (index >= 0) {
                    content = content.substring(0, index) + oldString + content.substring(index + newString.length());
                }
            }
        }

        return content;
    }
}

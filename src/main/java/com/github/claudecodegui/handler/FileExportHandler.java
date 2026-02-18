package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import javax.swing.*;
import java.awt.*;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.concurrent.CompletableFuture;

/**
 * File export handler.
 * Handles saving files (supports Markdown, JSON, and other formats).
 */
public class FileExportHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(FileExportHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "save_markdown",
        "save_json"
    };

    private final Gson gson = new Gson();

    public FileExportHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("save_markdown".equals(type)) {
            LOG.info("[FileExportHandler] 处理: save_markdown");
            handleSaveFile(content, ".md", com.github.claudecodegui.ClaudeCodeGuiBundle.message("file.saveMarkdownDialog"));
            return true;
        } else if ("save_json".equals(type)) {
            LOG.info("[FileExportHandler] 处理: save_json");
            handleSaveFile(content, ".json", com.github.claudecodegui.ClaudeCodeGuiBundle.message("file.saveJsonDialog"));
            return true;
        }
        return false;
    }

    /**
     * Handle saving a file (supports multiple formats).
     */
    private void handleSaveFile(String jsonContent, String fileExtension, String dialogTitle) {
        try {
            LOG.info("[FileExportHandler] ========== 开始保存文件 ==========");
            LOG.info("[FileExportHandler] 文件类型: " + fileExtension);

            // Parse JSON
            JsonObject json = gson.fromJson(jsonContent, JsonObject.class);
            String content = json.get("content").getAsString();
            String filename = json.get("filename").getAsString();

            LOG.info("[FileExportHandler] 文件名: " + filename);

            // Show file dialog and save on the EDT thread
            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    // Get project path as the default directory
                    String projectPath = context.getProject().getBasePath();

                    // Use FileDialog for a native system dialog
                    FileDialog fileDialog = new FileDialog((Frame) null, dialogTitle, FileDialog.SAVE);

                    // Set default directory
                    if (projectPath != null) {
                        fileDialog.setDirectory(projectPath);
                    }

                    // Set default filename
                    fileDialog.setFile(filename);

                    // Set file filter
                    fileDialog.setFilenameFilter((dir, name) -> name.toLowerCase().endsWith(fileExtension));

                    // Show the dialog
                    fileDialog.setVisible(true);

                    // Get the user-selected file
                    String selectedDir = fileDialog.getDirectory();
                    String selectedFile = fileDialog.getFile();

                    if (selectedDir != null && selectedFile != null) {
                        File fileToSave = new File(selectedDir, selectedFile);

                        // Ensure the file extension is correct
                        String path = fileToSave.getAbsolutePath();
                        if (!path.toLowerCase().endsWith(fileExtension)) {
                            fileToSave = new File(path + fileExtension);
                        }

                        // Write the file (perform I/O on a background thread)
                        File finalFileToSave = fileToSave;
                        CompletableFuture.runAsync(() -> {
                            try (FileWriter writer = new FileWriter(finalFileToSave)) {
                                writer.write(content);
                                LOG.info("[FileExportHandler] ✅ 文件保存成功: " + finalFileToSave.getAbsolutePath());

                                // Notify frontend of success
                                ApplicationManager.getApplication().invokeLater(() -> {
                                    String successMsg = escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("file.saved"));
                                    String jsCode = "if (window.addToast) { " +
                                        "  window.addToast('" + successMsg + "', 'success'); " +
                                        "}";
                                    context.executeJavaScriptOnEDT(jsCode);
                                });

                            } catch (IOException e) {
                                LOG.error("[FileExportHandler] ❌ 保存文件失败: " + e.getMessage(), e);

                                // Notify frontend of failure
                                ApplicationManager.getApplication().invokeLater(() -> {
                                    String errorDetail = e.getMessage() != null ? e.getMessage() : com.github.claudecodegui.ClaudeCodeGuiBundle.message("file.saveFailed");
                                    String errorMsg = escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("file.saveFailedWithReason", errorDetail));
                                    String jsCode = "if (window.addToast) { " +
                                        "  window.addToast('" + errorMsg + "', 'error'); " +
                                        "}";
                                    context.executeJavaScriptOnEDT(jsCode);
                                });
                            }
                        });
                    } else {
                        LOG.info("[FileExportHandler] 用户取消了保存");
                    }
                } catch (Exception e) {
                    LOG.error("[FileExportHandler] ❌ 显示对话框失败: " + e.getMessage(), e);

                    String errorDetail = e.getMessage() != null ? e.getMessage() : com.github.claudecodegui.ClaudeCodeGuiBundle.message("file.showDialogFailed");
                    String errorMsg = escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("file.saveFailedWithReason", errorDetail));
                    String jsCode = "if (window.addToast) { " +
                        "  window.addToast('" + errorMsg + "', 'error'); " +
                        "}";
                    context.executeJavaScriptOnEDT(jsCode);
                }

                LOG.info("[FileExportHandler] ========== 保存文件完成 ==========");
            });

        } catch (Exception e) {
            LOG.error("[FileExportHandler] ❌ 处理保存请求失败: " + e.getMessage(), e);

            ApplicationManager.getApplication().invokeLater(() -> {
                String errorDetail = e.getMessage() != null ? e.getMessage() : com.github.claudecodegui.ClaudeCodeGuiBundle.message("file.unknownError");
                String errorMsg = escapeJs(com.github.claudecodegui.ClaudeCodeGuiBundle.message("file.saveFailedWithReason", errorDetail));
                String jsCode = "if (window.addToast) { " +
                    "  window.addToast('" + errorMsg + "', 'error'); " +
                    "}";
                context.executeJavaScriptOnEDT(jsCode);
            });
        }
    }
}

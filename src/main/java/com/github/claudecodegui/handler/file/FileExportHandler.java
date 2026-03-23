package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import javax.swing.*;
import java.awt.*;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
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
            handleSaveFile(content, ".md", com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("file.saveMarkdownDialog"));
            return true;
        } else if ("save_json".equals(type)) {
            LOG.info("[FileExportHandler] 处理: save_json");
            handleSaveFile(content, ".json", com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("file.saveJsonDialog"));
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

            JsonObject json = gson.fromJson(jsonContent, JsonObject.class);
            String content = json.get("content").getAsString();
            String filename = json.get("filename").getAsString();

            LOG.info("[FileExportHandler] 文件名: " + filename);

            ApplicationManager.getApplication().invokeLater(() -> {
                File selectedFile = showSaveDialog(dialogTitle, fileExtension, filename);
                if (selectedFile != null) {
                    writeFileAsync(selectedFile, content);
                } else {
                    LOG.info("[FileExportHandler] 用户取消了保存");
                }
                LOG.info("[FileExportHandler] ========== 保存文件完成 ==========");
            });

        } catch (Exception e) {
            LOG.error("[FileExportHandler] 处理保存请求失败: " + e.getMessage(), e);
            notifyError(e.getMessage());
        }
    }

    private File showSaveDialog(String dialogTitle, String fileExtension, String filename) {
        try {
            String projectPath = context.getProject().getBasePath();
            FileDialog fileDialog = new FileDialog((Frame) null, dialogTitle, FileDialog.SAVE);

            if (projectPath != null) {
                fileDialog.setDirectory(projectPath);
            }
            fileDialog.setFile(filename);
            fileDialog.setFilenameFilter((dir, name) -> name.toLowerCase().endsWith(fileExtension));
            fileDialog.setVisible(true);

            String selectedDir = fileDialog.getDirectory();
            String selectedFile = fileDialog.getFile();

            if (selectedDir != null && selectedFile != null) {
                File fileToSave = new File(selectedDir, selectedFile);
                String path = fileToSave.getAbsolutePath();
                if (!path.toLowerCase().endsWith(fileExtension)) {
                    fileToSave = new File(path + fileExtension);
                }
                return fileToSave;
            }
            return null;
        } catch (Exception e) {
            LOG.error("[FileExportHandler] 显示对话框失败: " + e.getMessage(), e);
            notifyError(e.getMessage());
            return null;
        }
    }

    private void writeFileAsync(File fileToSave, String content) {
        CompletableFuture.runAsync(() -> {
            try (FileWriter writer = new FileWriter(fileToSave, StandardCharsets.UTF_8)) {
                writer.write(content);
                LOG.info("[FileExportHandler] 文件保存成功: " + fileToSave.getAbsolutePath());
                notifySuccess(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("file.saved"));
            } catch (IOException e) {
                LOG.error("[FileExportHandler] 保存文件失败: " + e.getMessage(), e);
                String errorDetail = e.getMessage() != null ? e.getMessage() : com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("file.saveFailed");
                notifyError(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("file.saveFailedWithReason", errorDetail));
            }
        });
    }

    private void notifySuccess(String message) {
        ApplicationManager.getApplication().invokeLater(() -> {
            String jsCode = "if (window.addToast) { " +
                "  window.addToast('" + escapeJs(message) + "', 'success'); " +
                "}";
            context.executeJavaScriptOnEDT(jsCode);
        });
    }

    private void notifyError(String message) {
        ApplicationManager.getApplication().invokeLater(() -> {
            String errorDetail = message != null ? message : com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("file.unknownError");
            String errorMsg = escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("file.saveFailedWithReason", errorDetail));
            String jsCode = "if (window.addToast) { " +
                "  window.addToast('" + errorMsg + "', 'error'); " +
                "}";
            context.executeJavaScriptOnEDT(jsCode);
        });
    }
}

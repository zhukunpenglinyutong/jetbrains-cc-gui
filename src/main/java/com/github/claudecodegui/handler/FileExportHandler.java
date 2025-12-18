package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

import javax.swing.*;
import java.awt.*;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.concurrent.CompletableFuture;

/**
 * 文件导出处理器
 * 处理文件保存（支持 Markdown、JSON 等格式）
 */
public class FileExportHandler extends BaseMessageHandler {

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
            System.out.println("[FileExportHandler] 处理: save_markdown");
            handleSaveFile(content, ".md", "保存 Markdown 文件");
            return true;
        } else if ("save_json".equals(type)) {
            System.out.println("[FileExportHandler] 处理: save_json");
            handleSaveFile(content, ".json", "保存 JSON 文件");
            return true;
        }
        return false;
    }

    /**
     * 处理保存文件（支持多种格式）
     */
    private void handleSaveFile(String jsonContent, String fileExtension, String dialogTitle) {
        CompletableFuture.runAsync(() -> {
            try {
                System.out.println("[FileExportHandler] ========== 开始保存文件 ==========");
                System.out.println("[FileExportHandler] 文件类型: " + fileExtension);

                // 解析 JSON
                JsonObject json = gson.fromJson(jsonContent, JsonObject.class);
                String content = json.get("content").getAsString();
                String filename = json.get("filename").getAsString();

                System.out.println("[FileExportHandler] 文件名: " + filename);

                // 在 EDT 线程显示原生文件选择对话框
                SwingUtilities.invokeAndWait(() -> {
                    // 获取项目路径作为默认目录
                    String projectPath = context.getProject().getBasePath();

                    // 使用 FileDialog 以获得原生系统对话框
                    FileDialog fileDialog = new FileDialog((Frame) null, dialogTitle, FileDialog.SAVE);

                    // 设置默认目录
                    if (projectPath != null) {
                        fileDialog.setDirectory(projectPath);
                    }

                    // 设置默认文件名
                    fileDialog.setFile(filename);

                    // 设置文件过滤器
                    fileDialog.setFilenameFilter((dir, name) -> name.toLowerCase().endsWith(fileExtension));

                    // 显示对话框
                    fileDialog.setVisible(true);

                    // 获取用户选择的文件
                    String selectedDir = fileDialog.getDirectory();
                    String selectedFile = fileDialog.getFile();

                    if (selectedDir != null && selectedFile != null) {
                        File fileToSave = new File(selectedDir, selectedFile);

                        // 确保文件扩展名正确
                        String path = fileToSave.getAbsolutePath();
                        if (!path.toLowerCase().endsWith(fileExtension)) {
                            fileToSave = new File(path + fileExtension);
                        }

                        try {
                            // 写入文件
                            try (FileWriter writer = new FileWriter(fileToSave)) {
                                writer.write(content);
                            }

                            System.out.println("[FileExportHandler] ✅ 文件保存成功: " + fileToSave.getAbsolutePath());

                            // 通知前端成功
                            String jsCode = "if (window.addToast) { " +
                                "  window.addToast('文件已保存', 'success'); " +
                                "}";
                            context.executeJavaScriptOnEDT(jsCode);

                        } catch (IOException e) {
                            System.err.println("[FileExportHandler] ❌ 保存文件失败: " + e.getMessage());
                            e.printStackTrace();

                            // 通知前端失败
                            String errorMsg = escapeJs(e.getMessage() != null ? e.getMessage() : "保存失败");
                            String jsCode = "if (window.addToast) { " +
                                "  window.addToast('保存失败: " + errorMsg + "', 'error'); " +
                                "}";
                            context.executeJavaScriptOnEDT(jsCode);
                        }
                    } else {
                        System.out.println("[FileExportHandler] 用户取消了保存");
                    }
                });

                System.out.println("[FileExportHandler] ========== 保存文件完成 ==========");

            } catch (Exception e) {
                System.err.println("[FileExportHandler] ❌ 处理保存请求失败: " + e.getMessage());
                e.printStackTrace();

                SwingUtilities.invokeLater(() -> {
                    String errorMsg = escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误");
                    String jsCode = "if (window.addToast) { " +
                        "  window.addToast('保存失败: " + errorMsg + "', 'error'); " +
                        "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });
            }
        });
    }
}

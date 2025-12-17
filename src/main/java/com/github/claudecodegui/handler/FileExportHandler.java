package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

import javax.swing.*;
import javax.swing.filechooser.FileNameExtensionFilter;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.concurrent.CompletableFuture;

/**
 * 文件导出处理器
 * 处理 Markdown 文件保存
 */
public class FileExportHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {
        "save_markdown"
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
            handleSaveMarkdown(content);
            return true;
        }
        return false;
    }

    /**
     * 处理保存 Markdown 文件
     */
    private void handleSaveMarkdown(String jsonContent) {
        CompletableFuture.runAsync(() -> {
            try {
                System.out.println("[FileExportHandler] ========== 开始保存 Markdown 文件 ==========");

                // 解析 JSON
                JsonObject json = gson.fromJson(jsonContent, JsonObject.class);
                String content = json.get("content").getAsString();
                String filename = json.get("filename").getAsString();

                System.out.println("[FileExportHandler] 文件名: " + filename);

                // 在 EDT 线程显示文件选择对话框
                SwingUtilities.invokeAndWait(() -> {
                    // 获取项目路径作为默认目录
                    String projectPath = context.getProject().getBasePath();
                    JFileChooser fileChooser = new JFileChooser(projectPath);
                    fileChooser.setDialogTitle("保存 Markdown 文件");
                    fileChooser.setSelectedFile(new File(filename));

                    // 设置文件过滤器
                    FileNameExtensionFilter filter = new FileNameExtensionFilter(
                        "Markdown 文件 (*.md)", "md"
                    );
                    fileChooser.setFileFilter(filter);

                    int result = fileChooser.showSaveDialog(null);

                    if (result == JFileChooser.APPROVE_OPTION) {
                        File fileToSave = fileChooser.getSelectedFile();

                        // 确保文件扩展名是 .md
                        String path = fileToSave.getAbsolutePath();
                        if (!path.toLowerCase().endsWith(".md")) {
                            fileToSave = new File(path + ".md");
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

                System.out.println("[FileExportHandler] ========== 保存 Markdown 文件完成 ==========");

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

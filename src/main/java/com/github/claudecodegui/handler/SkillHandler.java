package com.github.claudecodegui.handler;

import com.github.claudecodegui.SkillService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.util.concurrency.AppExecutorUtil;

import javax.swing.*;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Skill 管理消息处理器
 */
public class SkillHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {
        "get_all_skills",
        "import_skill",
        "delete_skill",
        "open_skill",
        "toggle_skill"
    };

    private final JPanel mainPanel;

    public SkillHandler(HandlerContext context, JPanel mainPanel) {
        super(context);
        this.mainPanel = mainPanel;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_all_skills":
                handleGetAllSkills();
                return true;
            case "import_skill":
                handleImportSkill(content);
                return true;
            case "delete_skill":
                handleDeleteSkill(content);
                return true;
            case "open_skill":
                handleOpenSkill(content);
                return true;
            case "toggle_skill":
                handleToggleSkill(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * 获取所有 Skills (全局 + 本地)
     */
    private void handleGetAllSkills() {
        try {
            String workspaceRoot = context.getProject().getBasePath();
            JsonObject skills = SkillService.getAllSkills(workspaceRoot);
            Gson gson = new Gson();
            String skillsJson = gson.toJson(skills);

            SwingUtilities.invokeLater(() -> {
                callJavaScript("window.updateSkills", escapeJs(skillsJson));
            });
        } catch (Exception e) {
            System.err.println("[SkillHandler] Failed to get all skills: " + e.getMessage());
            e.printStackTrace();
            SwingUtilities.invokeLater(() -> {
                callJavaScript("window.updateSkills", escapeJs("{\"global\":{},\"local\":{}}"));
            });
        }
    }

    /**
     * 导入 Skill（显示文件选择对话框）
     */
    private void handleImportSkill(String content) {
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String scope = json.has("scope") ? json.get("scope").getAsString() : "global";

            SwingUtilities.invokeLater(() -> {
                JFileChooser chooser = new JFileChooser();
                chooser.setDialogTitle("选择 Skill 文件或文件夹");
                chooser.setFileSelectionMode(JFileChooser.FILES_AND_DIRECTORIES);
                chooser.setMultiSelectionEnabled(true);

                int result = chooser.showOpenDialog(mainPanel);
                if (result == JFileChooser.APPROVE_OPTION) {
                    File[] selectedFiles = chooser.getSelectedFiles();
                    List<String> paths = new ArrayList<>();
                    for (File file : selectedFiles) {
                        paths.add(file.getAbsolutePath());
                    }

                    CompletableFuture.runAsync(() -> {
                        try {
                            String workspaceRoot = context.getProject().getBasePath();
                            JsonObject importResult = SkillService.importSkills(paths, scope, workspaceRoot);
                            String resultJson = new Gson().toJson(importResult);

                            SwingUtilities.invokeLater(() -> {
                                callJavaScript("window.skillImportResult", escapeJs(resultJson));
                            });
                        } catch (Exception e) {
                            System.err.println("[SkillHandler] Import skill failed: " + e.getMessage());
                            JsonObject errorResult = new JsonObject();
                            errorResult.addProperty("success", false);
                            errorResult.addProperty("error", e.getMessage());
                            SwingUtilities.invokeLater(() -> {
                                callJavaScript("window.skillImportResult", escapeJs(new Gson().toJson(errorResult)));
                            });
                        }
                    });
                }
            });
        } catch (Exception e) {
            System.err.println("[SkillHandler] Failed to handle import skill: " + e.getMessage());
            e.printStackTrace();
        }
    }

    /**
     * 删除 Skill
     */
    private void handleDeleteSkill(String content) {
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String skillName = json.get("name").getAsString();
            String scope = json.has("scope") ? json.get("scope").getAsString() : "global";
            boolean enabled = json.has("enabled") ? json.get("enabled").getAsBoolean() : true;
            String workspaceRoot = context.getProject().getBasePath();

            JsonObject result = SkillService.deleteSkill(skillName, scope, enabled, workspaceRoot);
            String resultJson = gson.toJson(result);

            SwingUtilities.invokeLater(() -> {
                callJavaScript("window.skillDeleteResult", escapeJs(resultJson));
            });
        } catch (Exception e) {
            System.err.println("[SkillHandler] Failed to delete skill: " + e.getMessage());
            e.printStackTrace();
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("error", e.getMessage());
            SwingUtilities.invokeLater(() -> {
                callJavaScript("window.skillDeleteResult", escapeJs(new Gson().toJson(errorResult)));
            });
        }
    }

    /**
     * 启用/停用 Skill
     */
    private void handleToggleSkill(String content) {
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String skillName = json.get("name").getAsString();
            String scope = json.has("scope") ? json.get("scope").getAsString() : "global";
            boolean currentEnabled = json.has("enabled") ? json.get("enabled").getAsBoolean() : true;
            String workspaceRoot = context.getProject().getBasePath();

            JsonObject result = SkillService.toggleSkill(skillName, scope, currentEnabled, workspaceRoot);
            String resultJson = gson.toJson(result);

            SwingUtilities.invokeLater(() -> {
                callJavaScript("window.skillToggleResult", escapeJs(resultJson));
            });
        } catch (Exception e) {
            System.err.println("[SkillHandler] Failed to toggle skill: " + e.getMessage());
            e.printStackTrace();
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("error", e.getMessage());
            SwingUtilities.invokeLater(() -> {
                callJavaScript("window.skillToggleResult", escapeJs(new Gson().toJson(errorResult)));
            });
        }
    }

    /**
     * 在编辑器中打开 Skill
     */
    private void handleOpenSkill(String content) {
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String skillPath = json.get("path").getAsString();

            File skillFile = new File(skillPath);
            String targetPath = skillPath;

            // 如果是目录，尝试打开 skill.md 或 SKILL.md
            if (skillFile.isDirectory()) {
                File skillMd = new File(skillFile, "skill.md");
                if (!skillMd.exists()) {
                    skillMd = new File(skillFile, "SKILL.md");
                }
                if (skillMd.exists()) {
                    targetPath = skillMd.getAbsolutePath();
                }
            }

            final String fileToOpen = targetPath;

            // 使用 ReadAction.nonBlocking() 在后台线程中查找文件
            ReadAction
                .nonBlocking(() -> {
                    // 在后台线程中查找文件（这是慢操作）
                    return LocalFileSystem.getInstance().findFileByPath(fileToOpen);
                })
                .finishOnUiThread(com.intellij.openapi.application.ModalityState.defaultModalityState(), virtualFile -> {
                    // 在 UI 线程中打开文件
                    if (virtualFile != null) {
                        FileEditorManager.getInstance(context.getProject()).openFile(virtualFile, true);
                    } else {
                        System.err.println("[SkillHandler] Cannot find file: " + fileToOpen);
                    }
                })
                .submit(AppExecutorUtil.getAppExecutorService());

        } catch (Exception e) {
            System.err.println("[SkillHandler] Failed to open skill: " + e.getMessage());
            e.printStackTrace();
        }
    }
}

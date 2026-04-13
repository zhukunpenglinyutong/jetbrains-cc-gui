package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.skill.CodexSkillService;
import com.github.claudecodegui.skill.SkillService;
import com.github.claudecodegui.RemoteSkillService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Skill management message handler.
 */
public class SkillHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(SkillHandler.class);
    private static final Gson GSON = new Gson();

    private static final String[] SUPPORTED_TYPES = {
        "get_all_skills",
        "import_skill",
        "delete_skill",
        "open_skill",
        "toggle_skill",
        "import_remote_skill",
        "update_remote_skill",
        "update_remote_skill_interval",
        "import_from_navigation_directory"
    };

    public SkillHandler(HandlerContext context) {
        super(context);
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
            case "import_remote_skill":
                handleImportRemoteSkill(content);
                return true;
            case "update_remote_skill":
                handleUpdateRemoteSkill(content);
                return true;
            case "update_remote_skill_interval":
                handleUpdateRemoteSkillInterval(content);
                return true;
            case "import_from_navigation_directory":
                handleImportFromNavigationDirectory(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Get all skills (dispatches to Claude or Codex service based on provider).
     */
    private void handleGetAllSkills() {
        boolean isCodex = "codex".equalsIgnoreCase(context.getCurrentProvider());
        try {
            String workspaceRoot = context.getProject().getBasePath();

            JsonObject skills;
            if (isCodex) {
                skills = CodexSkillService.getAllSkills(workspaceRoot);
            } else {
                skills = SkillService.getAllSkills(workspaceRoot);
            }

            String skillsJson = GSON.toJson(skills);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateSkills", escapeJs(skillsJson));
            });
        } catch (Exception e) {
            LOG.error("[SkillHandler] Failed to get all skills: " + e.getMessage(), e);
            String fallbackJson = isCodex ? "{\"user\":{},\"repo\":{}}" : "{\"global\":{},\"local\":{}}";
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateSkills", escapeJs(fallbackJson));
            });
        }
    }

    /**
     * Import a skill (show file chooser dialog).
     * Dispatches to CodexSkillService or SkillService based on provider.
     */
    private void handleImportSkill(String content) {
        try {
            JsonObject json = GSON.fromJson(content, JsonObject.class);
            String scope = json.has("scope") ? json.get("scope").getAsString() : "global";
            boolean isCodex = "codex".equalsIgnoreCase(context.getCurrentProvider());

            ApplicationManager.getApplication().invokeLater(() -> {
                FileChooserDescriptor descriptor;
                if (isCodex) {
                    // Codex skills must be directories containing SKILL.md
                    descriptor = new FileChooserDescriptor(
                        false, // chooseFiles
                        true,  // chooseFolders
                        false, // chooseJars
                        false, // chooseJarsAsFiles
                        false, // chooseJarContents
                        true   // chooseMultiple
                    );
                    descriptor.setTitle("选择 Codex Skill 文件夹");
                } else {
                    descriptor = new FileChooserDescriptor(
                        true,  // chooseFiles
                        true,  // chooseFolders
                        false, // chooseJars
                        false, // chooseJarsAsFiles
                        false, // chooseJarContents
                        true   // chooseMultiple
                    );
                    descriptor.setTitle("选择 Skill 文件或文件夹");
                }

                // Set initial directory to project base path
                VirtualFile initialDir = null;
                String projectPath = context.getProject().getBasePath();
                if (projectPath != null) {
                    initialDir = LocalFileSystem.getInstance().findFileByPath(projectPath);
                }

                VirtualFile[] selectedFiles = FileChooser.chooseFiles(descriptor, context.getProject(), initialDir);
                if (selectedFiles.length > 0) {
                    List<String> paths = new ArrayList<>();
                    for (VirtualFile vf : selectedFiles) {
                        paths.add(vf.getPath());
                    }

                    CompletableFuture.runAsync(() -> {
                        try {
                            String workspaceRoot = context.getProject().getBasePath();
                            JsonObject importResult;
                            if (isCodex) {
                                importResult = CodexSkillService.importSkill(paths, scope, workspaceRoot);
                            } else {
                                importResult = SkillService.importSkills(paths, scope, workspaceRoot);
                            }
                            String resultJson = GSON.toJson(importResult);

                            ApplicationManager.getApplication().invokeLater(() -> {
                                callJavaScript("window.skillImportResult", escapeJs(resultJson));
                            });
                        } catch (Exception e) {
                            LOG.error("[SkillHandler] Import skill failed: " + e.getMessage(), e);
                            JsonObject errorResult = new JsonObject();
                            errorResult.addProperty("success", false);
                            errorResult.addProperty("error", e.getMessage());
                            ApplicationManager.getApplication().invokeLater(() -> {
                                callJavaScript("window.skillImportResult", escapeJs(GSON.toJson(errorResult)));
                            });
                        }
                    }, AppExecutorUtil.getAppExecutorService());
                }
            });
        } catch (Exception e) {
            LOG.error("[SkillHandler] Failed to handle import skill: " + e.getMessage(), e);
        }
    }

    /**
     * Delete a skill. Dispatches to CodexSkillService or SkillService based on provider.
     */
    private void handleDeleteSkill(String content) {
        try {
            JsonObject json = GSON.fromJson(content, JsonObject.class);
            String skillName = json.get("name").getAsString();
            String scope = json.has("scope") ? json.get("scope").getAsString() : "global";
            boolean enabled = json.has("enabled") ? json.get("enabled").getAsBoolean() : true;
            String workspaceRoot = context.getProject().getBasePath();
            boolean isCodex = "codex".equalsIgnoreCase(context.getCurrentProvider());

            CompletableFuture.runAsync(() -> {
                try {
                    JsonObject result;
                    if (isCodex) {
                        String skillPath = json.has("skillPath") ? json.get("skillPath").getAsString() : null;
                        // Validate skillPath: reject traversal sequences, null bytes, and non-normalized paths
                        if (skillPath != null && !isPathClean(skillPath)) {
                            result = new JsonObject();
                            result.addProperty("success", false);
                            result.addProperty("error", "Invalid skill path");
                        } else {
                            result = CodexSkillService.deleteSkill(skillName, scope, skillPath, workspaceRoot);
                        }
                    } else {
                        result = SkillService.deleteSkill(skillName, scope, enabled, workspaceRoot);
                    }
                    String resultJson = GSON.toJson(result);

                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.skillDeleteResult", escapeJs(resultJson));
                    });
                } catch (Exception e) {
                    LOG.error("[SkillHandler] Delete skill failed: " + e.getMessage(), e);
                    JsonObject errorResult = new JsonObject();
                    errorResult.addProperty("success", false);
                    errorResult.addProperty("error", e.getMessage());
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.skillDeleteResult", escapeJs(GSON.toJson(errorResult)));
                    });
                }
            }, AppExecutorUtil.getAppExecutorService());
        } catch (Exception e) {
            LOG.error("[SkillHandler] Failed to delete skill: " + e.getMessage(), e);
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("error", e.getMessage());
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.skillDeleteResult", escapeJs(GSON.toJson(errorResult)));
            });
        }
    }

    /**
     * Enable/disable a skill. Dispatches to CodexSkillService or SkillService based on provider.
     */
    private void handleToggleSkill(String content) {
        try {
            JsonObject json = GSON.fromJson(content, JsonObject.class);
            String skillName = json.get("name").getAsString();
            String scope = json.has("scope") ? json.get("scope").getAsString() : "global";
            boolean currentEnabled = json.has("enabled") ? json.get("enabled").getAsBoolean() : true;
            String workspaceRoot = context.getProject().getBasePath();
            boolean isCodex = "codex".equalsIgnoreCase(context.getCurrentProvider());

            CompletableFuture.runAsync(() -> {
                try {
                    JsonObject result;
                    if (isCodex) {
                        String skillPath = json.has("skillPath") ? json.get("skillPath").getAsString() : null;
                        if (skillPath == null || skillPath.isEmpty()) {
                            result = new JsonObject();
                            result.addProperty("success", false);
                            result.addProperty("error", "skillPath is required for Codex skill toggle");
                        } else if (!isPathClean(skillPath)) {
                            result = new JsonObject();
                            result.addProperty("success", false);
                            result.addProperty("error", "Invalid skill path");
                        } else {
                            result = CodexSkillService.toggleSkill(skillPath, currentEnabled, workspaceRoot);
                        }
                    } else {
                        result = SkillService.toggleSkill(skillName, scope, currentEnabled, workspaceRoot);
                    }
                    String resultJson = GSON.toJson(result);

                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.skillToggleResult", escapeJs(resultJson));
                    });
                } catch (Exception e) {
                    LOG.error("[SkillHandler] Toggle skill failed: " + e.getMessage(), e);
                    JsonObject errorResult = new JsonObject();
                    errorResult.addProperty("success", false);
                    errorResult.addProperty("error", e.getMessage());
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.skillToggleResult", escapeJs(GSON.toJson(errorResult)));
                    });
                }
            }, AppExecutorUtil.getAppExecutorService());
        } catch (Exception e) {
            LOG.error("[SkillHandler] Failed to toggle skill: " + e.getMessage(), e);
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("error", e.getMessage());
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.skillToggleResult", escapeJs(GSON.toJson(errorResult)));
            });
        }
    }

    /**
     * Check if a path is free of traversal sequences and normalizes to itself.
     * This is a defense-in-depth check; individual service methods perform their own validation.
     */
    private static boolean isPathClean(String path) {
        if (path == null || path.isEmpty()) return false;
        if (path.contains("\0")) return false;
        try {
            Path original = Paths.get(path).toAbsolutePath();
            Path normalized = original.normalize();
            return original.toString().equals(normalized.toString());
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Check if a path is inside any legitimate skills directory.
     */
    private boolean isInsideSkillsDirectory(String path) {
        try {
            Path normalized = Paths.get(path).toAbsolutePath().normalize();
            String userHome = com.github.claudecodegui.util.PlatformUtils.getHomeDirectory();
            String projectBase = context.getProject().getBasePath();

            // Claude skills directories
            List<Path> validBases = new ArrayList<>();
            validBases.add(Paths.get(userHome, ".claude", "skills"));
            validBases.add(Paths.get(userHome, ".claude", "commands"));
            validBases.add(Paths.get(userHome, ".codemoss", "skills"));
            // Codex skills directories
            validBases.add(Paths.get(userHome, ".agents", "skills"));
            validBases.add(Paths.get(userHome, ".codex", "skills"));

            if (projectBase != null) {
                validBases.add(Paths.get(projectBase, ".claude", "skills"));
                validBases.add(Paths.get(projectBase, ".claude", "commands"));
                validBases.add(Paths.get(projectBase, ".agents", "skills"));
            }

            for (Path base : validBases) {
                if (normalized.startsWith(base.toAbsolutePath().normalize())) {
                    return true;
                }
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Import remote skill.
     */
    private void handleImportRemoteSkill(String content) {
        try {
            JsonObject json = GSON.fromJson(content, JsonObject.class);
            String url = json.get("url").getAsString();
            String scope = json.has("scope") ? json.get("scope").getAsString() : "global";
            String updateInterval = json.has("updateInterval") ? json.get("updateInterval").getAsString() : "manual";
            String workspaceRoot = context.getProject().getBasePath();

            CompletableFuture.runAsync(() -> {
                try {
                    JsonObject result = RemoteSkillService.importRemoteSkill(url, scope, updateInterval, workspaceRoot);
                    String resultJson = GSON.toJson(result);

                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.skillImportResult", escapeJs(resultJson));
                    });
                } catch (Exception e) {
                    LOG.error("[SkillHandler] Import remote skill failed: " + e.getMessage(), e);
                    JsonObject errorResult = new JsonObject();
                    errorResult.addProperty("success", false);
                    errorResult.addProperty("error", e.getMessage());
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.skillImportResult", escapeJs(GSON.toJson(errorResult)));
                    });
                }
            }, AppExecutorUtil.getAppExecutorService());
        } catch (Exception e) {
            LOG.error("[SkillHandler] Failed to handle import remote skill: " + e.getMessage(), e);
        }
    }

    /**
     * Update remote skill.
     */
    private void handleUpdateRemoteSkill(String content) {
        try {
            JsonObject json = GSON.fromJson(content, JsonObject.class);
            String name = json.get("name").getAsString();
            String scope = json.get("scope").getAsString();
            String url = json.get("url").getAsString();
            String workspaceRoot = context.getProject().getBasePath();

            CompletableFuture.runAsync(() -> {
                try {
                    JsonObject result = RemoteSkillService.updateRemoteSkill(name, scope, url, workspaceRoot);
                    String resultJson = GSON.toJson(result);

                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (result.get("success").getAsBoolean()) {
                            callJavaScript("window.skillImportResult", escapeJs(resultJson));
                            // Refresh skills list
                            handleGetAllSkills();
                        } else {
                            callJavaScript("window.skillImportResult", escapeJs(resultJson));
                        }
                    });
                } catch (Exception e) {
                    LOG.error("[SkillHandler] Update remote skill failed: " + e.getMessage(), e);
                    JsonObject errorResult = new JsonObject();
                    errorResult.addProperty("success", false);
                    errorResult.addProperty("error", e.getMessage());
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.skillImportResult", escapeJs(GSON.toJson(errorResult)));
                    });
                }
            }, AppExecutorUtil.getAppExecutorService());
        } catch (Exception e) {
            LOG.error("[SkillHandler] Failed to handle update remote skill: " + e.getMessage(), e);
        }
    }

    /**
     * Update remote skill interval.
     */
    private void handleUpdateRemoteSkillInterval(String content) {
        try {
            JsonObject json = GSON.fromJson(content, JsonObject.class);
            String name = json.get("name").getAsString();
            String scope = json.get("scope").getAsString();
            String updateInterval = json.get("updateInterval").getAsString();

            CompletableFuture.runAsync(() -> {
                try {
                    JsonObject result = RemoteSkillService.updateRemoteSkillInterval(name, scope, updateInterval);

                    ApplicationManager.getApplication().invokeLater(() -> {
                        // Refresh skills list to show updated config
                        handleGetAllSkills();
                    });
                } catch (Exception e) {
                    LOG.error("[SkillHandler] Update remote skill interval failed: " + e.getMessage(), e);
                }
            }, AppExecutorUtil.getAppExecutorService());
        } catch (Exception e) {
            LOG.error("[SkillHandler] Failed to handle update remote skill interval: " + e.getMessage(), e);
        }
    }

    /**
     * Import skills from navigation directory.
     */
    private void handleImportFromNavigationDirectory(String content) {
        try {
            JsonObject json = GSON.fromJson(content, JsonObject.class);
            String navUrl = json.get("url").getAsString();
            String scope = json.has("scope") ? json.get("scope").getAsString() : "global";
            String updateInterval = json.has("updateInterval") ? json.get("updateInterval").getAsString() : "manual";
            String workspaceRoot = context.getProject().getBasePath();

            LOG.info("[SkillHandler] Batch import request - scope: " + scope + ", workspaceRoot: " + workspaceRoot + ", url: " + navUrl);

            // Validate workspaceRoot for local/repo scopes
            if (("local".equals(scope) || "repo".equals(scope)) && (workspaceRoot == null || workspaceRoot.isEmpty())) {
                LOG.error("[SkillHandler] Cannot import to local/repo scope: workspaceRoot is null or empty");
                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("success", false);
                errorResult.addProperty("error", "Cannot import to " + scope + " scope: no project directory found");
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.skillBatchImportResult", escapeJs(GSON.toJson(errorResult)));
                });
                return;
            }

            CompletableFuture.runAsync(() -> {
                try {
                    JsonObject result = RemoteSkillService.importFromNavigationDirectory(navUrl, scope, updateInterval, workspaceRoot);
                    String resultJson = GSON.toJson(result);

                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.skillBatchImportResult", escapeJs(resultJson));
                        // Refresh skills list if any succeeded
                        if (result.has("succeeded") && result.get("succeeded").getAsInt() > 0) {
                            handleGetAllSkills();
                        }
                    });
                } catch (Exception e) {
                    LOG.error("[SkillHandler] Import from navigation directory failed: " + e.getMessage(), e);
                    JsonObject errorResult = new JsonObject();
                    errorResult.addProperty("success", false);
                    errorResult.addProperty("error", e.getMessage());
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.skillBatchImportResult", escapeJs(GSON.toJson(errorResult)));
                    });
                }
            }, AppExecutorUtil.getAppExecutorService());
        } catch (Exception e) {
            LOG.error("[SkillHandler] Failed to handle import from navigation directory: " + e.getMessage(), e);
        }
    }

    /**
     * Open a skill in the editor.
     */
    private void handleOpenSkill(String content) {
        try {
            JsonObject json = GSON.fromJson(content, JsonObject.class);
            String skillPath = json.get("path").getAsString();

            // Validate path: reject traversal sequences, null bytes, and paths outside skills directories
            if (skillPath.contains("..") || skillPath.contains("\0")) {
                LOG.warn("[SkillHandler] Rejected open request with suspicious path: " + skillPath);
                return;
            }
            if (!isInsideSkillsDirectory(skillPath)) {
                LOG.warn("[SkillHandler] Rejected open request for path outside skills directories");
                return;
            }

            File skillFile = new File(skillPath);
            String targetPath = skillPath;

            // If it's a directory, try opening skill.md or SKILL.md
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

            // Use ReadAction.nonBlocking() to find the file in a background thread
            ReadAction
                .nonBlocking(() -> {
                    // Find the file in a background thread (this is a slow operation)
                    return LocalFileSystem.getInstance().findFileByPath(fileToOpen);
                })
                .finishOnUiThread(com.intellij.openapi.application.ModalityState.defaultModalityState(), virtualFile -> {
                    // Open the file on the UI thread
                    if (virtualFile != null) {
                        FileEditorManager.getInstance(context.getProject()).openFile(virtualFile, true);
                    } else {
                        LOG.error("[SkillHandler] Cannot find file: " + fileToOpen);
                    }
                })
                .submit(AppExecutorUtil.getAppExecutorService());

        } catch (Exception e) {
            LOG.error("[SkillHandler] Failed to open skill: " + e.getMessage(), e);
        }
    }
}

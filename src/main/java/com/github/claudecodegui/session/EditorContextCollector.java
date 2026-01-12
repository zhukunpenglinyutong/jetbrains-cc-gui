package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.context.ContextCollector;
import com.github.claudecodegui.util.EditorFileUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.project.Project;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 编辑器上下文收集器
 * 负责收集 IDE 编辑器中的上下文信息(打开的文件、选中的代码等)
 */
public class EditorContextCollector {
    private static final Logger LOG = Logger.getInstance(EditorContextCollector.class);

    private final Project project;
    private boolean psiContextEnabled = true;

    private boolean isQuickFix = false;

    public EditorContextCollector(Project project) {
        this.project = project;
    }

    public void setQuickFix(boolean quickFix) {
        this.isQuickFix = quickFix;
    }

    public void setPsiContextEnabled(boolean enabled) {
        this.psiContextEnabled = enabled;
    }

    /**
     * 异步收集编辑器上下文信息
     */
    public CompletableFuture<JsonObject> collectContext() {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();

        // First, get editor on EDT (required for getSelectedTextEditor)
        AtomicReference<Editor> editorRef = new AtomicReference<>();
        AtomicReference<String> activeFileRef = new AtomicReference<>();

        ApplicationManager.getApplication().invokeAndWait(() -> {
            try {
                editorRef.set(FileEditorManager.getInstance(project).getSelectedTextEditor());
                activeFileRef.set(EditorFileUtils.getCurrentActiveFile(project));
            } catch (Exception e) {
                LOG.warn("Failed to get editor on EDT: " + e.getMessage());
            }
        });

        // Then collect context in background read action
        ReadAction
            .nonBlocking(() -> {
                try {
                    return buildContextJson(editorRef.get(), activeFileRef.get());
                } catch (Exception e) {
                    LOG.warn("Failed to get file info: " + e.getMessage());
                    return new JsonObject();
                }
            })
            .finishOnUiThread(com.intellij.openapi.application.ModalityState.defaultModalityState(), future::complete)
            .submit(AppExecutorUtil.getAppExecutorService());

        return future;
    }

    /**
     * 构建上下文 JSON 对象
     */
    private JsonObject buildContextJson(Editor editor, String activeFile) {
        /*
         * ========== 编辑器上下文信息采集 ==========
         *
         * 此处采集用户在 IDEA 编辑器中的工作环境信息,用于帮助 AI 理解用户当前的代码上下文。
         * 这些信息会被构建成 JSON 格式,最终附加到发送给 AI 的系统提示词中。
         *
         * 采集的信息按优先级分为四层:
         * 1. active (当前激活的文件) - 优先级最高,AI 的主要关注点
         * 2. selection (用户选中的代码) - 如果存在,则是 AI 应该重点分析的核心对象
         * 3. semantic (PSI语义信息) - 代码结构、引用、继承关系等
         * 4. others (其他打开的文件) - 优先级最低,作为潜在的上下文参考
         */

        List<String> allOpenedFiles = EditorFileUtils.getOpenedFiles(project);
        Map<String, Object> selectionInfo = EditorFileUtils.getSelectedCodeInfo(project);

        JsonObject openedFilesJson = new JsonObject();

        if (activeFile != null) {
            // 添加当前激活的文件路径
            openedFilesJson.addProperty("active", activeFile);
            LOG.debug("Current active file: " + activeFile);

            // 如果用户选中了代码,添加选中信息
            if (selectionInfo != null) {
                JsonObject selectionJson = new JsonObject();
                selectionJson.addProperty("startLine", (Integer) selectionInfo.get("startLine"));
                selectionJson.addProperty("endLine", (Integer) selectionInfo.get("endLine"));
                selectionJson.addProperty("selectedText", (String) selectionInfo.get("selectedText"));
                openedFilesJson.add("selection", selectionJson);
                LOG.debug("Code selection detected: lines " +
                    selectionInfo.get("startLine") + "-" + selectionInfo.get("endLine"));
            }

            // 收集 PSI 语义上下文 (所有文件)
            if (psiContextEnabled && editor != null && activeFile != null) {
                try {
                    ContextCollector semanticCollector = new ContextCollector();
                    JsonObject semanticContext = semanticCollector.collectSemanticContext(editor, project);
                    if (semanticContext != null && semanticContext.size() > 0) {
                        // Merge semantic context properties directly into main object
                        for (String key : semanticContext.keySet()) {
                            openedFilesJson.add(key, semanticContext.get(key));
                        }
                        LOG.debug("PSI semantic context merged for: " + activeFile);
                    }
                } catch (Exception e) {
                    LOG.warn("Failed to collect PSI semantic context: " + e.getMessage());
                }
            }
        }

        // 添加其他打开的文件(排除激活文件,避免重复)
        JsonArray othersArray = new JsonArray();
        for (String file : allOpenedFiles) {
            if (!file.equals(activeFile)) {
                othersArray.add(file);
            }
        }
        if (othersArray.size() > 0) {
            openedFilesJson.add("others", othersArray);
            LOG.debug("Other opened files count: " + othersArray.size());
        }

        if (isQuickFix) {
            openedFilesJson.addProperty("isQuickFix", true);
        }

        return openedFilesJson;
    }
}

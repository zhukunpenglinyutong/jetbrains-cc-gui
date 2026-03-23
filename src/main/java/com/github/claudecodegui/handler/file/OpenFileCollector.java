package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;

import java.util.List;

/**
 * Collects currently open files from the editor.
 */
class OpenFileCollector {

    private static final Logger LOG = Logger.getInstance(OpenFileCollector.class);

    private final HandlerContext context;

    OpenFileCollector(HandlerContext context) {
        this.context = context;
    }

    /**
     * Collect currently open files.
     */
    void collect(List<JsonObject> files, FileHandler.FileSet fileSet, String basePath, FileHandler.FileListRequest request) {
        ApplicationManager.getApplication().runReadAction(() -> {
            Project project = context.getProject();
            if (project == null || project.isDisposed()) {
                LOG.debug("[FileHandler] Project is null or disposed in collectOpenFiles");
                return;
            }

            try {
                // Double-check project state inside read action
                if (project.isDisposed()) {
                    LOG.debug("[FileHandler] Project disposed during collectOpenFiles");
                    return;
                }

                VirtualFile[] openFiles = FileEditorManager.getInstance(project).getOpenFiles();
                LOG.debug("[FileHandler] Collecting " + openFiles.length + " open files");

                for (VirtualFile vf : openFiles) {
                    FileHandler.addVirtualFile(vf, basePath, files, fileSet, request, 1);
                }
            } catch (Exception e) {
                LOG.warn("[FileHandler] Error collecting open files: " + e.getMessage(), e);
            }
        });
    }
}

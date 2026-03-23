package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileEditor.impl.EditorHistoryManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;

import java.util.List;

/**
 * Collects recently opened files from the editor history.
 */
class RecentFileCollector {

    private static final Logger LOG = Logger.getInstance(RecentFileCollector.class);

    private static final int MAX_RECENT_FILES = 50;

    private final HandlerContext context;

    RecentFileCollector(HandlerContext context) {
        this.context = context;
    }

    /**
     * Collect recently opened files.
     */
    void collect(List<JsonObject> files, FileHandler.FileSet fileSet, String basePath, FileHandler.FileListRequest request) {
        ApplicationManager.getApplication().runReadAction(() -> {
            Project project = context.getProject();
            if (project == null || project.isDisposed()) {
                LOG.debug("[FileHandler] Project is null or disposed in collectRecentFiles");
                return;
            }

            try {
                // Double-check project state inside read action
                if (project.isDisposed()) {
                    LOG.debug("[FileHandler] Project disposed during collectRecentFiles");
                    return;
                }

                List<VirtualFile> recentFiles = EditorHistoryManager.getInstance(project).getFileList();
                if (recentFiles == null) {
                    LOG.warn("[FileHandler] EditorHistoryManager returned null file list");
                    return;
                }

                LOG.debug("[FileHandler] Collecting up to " + MAX_RECENT_FILES + " recent files from " + recentFiles.size() + " total");

                // Iterate in reverse order to get the most recent files
                int count = 0;
                for (int i = recentFiles.size() - 1; i >= 0; i--) {
                    if (count >= MAX_RECENT_FILES) {
                        break;
                    }
                    VirtualFile vf = recentFiles.get(i);
                    if (vf != null) {
                        FileHandler.addVirtualFile(vf, basePath, files, fileSet, request, 2);
                        count++;
                    }
                }
            } catch (Throwable t) {
                LOG.warn("[FileHandler] Failed to get recent files: " + t.getMessage(), t);
            }
        });
    }
}

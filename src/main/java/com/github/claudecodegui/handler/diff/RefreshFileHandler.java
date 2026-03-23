package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.EditorFileUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Handles refresh_file requests.
 */
public class RefreshFileHandler implements DiffActionHandler {

    private static final Logger LOG = Logger.getInstance(RefreshFileHandler.class);

    private final HandlerContext context;
    private final Gson gson;
    private final DiffFileOperations fileOperations;

    public RefreshFileHandler(HandlerContext context, Gson gson, DiffFileOperations fileOperations) {
        this.context = context;
        this.gson = gson;
        this.fileOperations = fileOperations;
    }

    private static final String[] TYPES = {"refresh_file"};

    @Override
    public String[] getSupportedTypes() {
        return TYPES;
    }

    @Override
    public void handle(String type, String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : null;

            if (filePath == null || filePath.isEmpty()) {
                LOG.warn("refresh_file: filePath is empty");
                return;
            }

            if (!fileOperations.isPathWithinProject(filePath)) {
                LOG.warn("Security: file path outside project directory: " + filePath);
                return;
            }

            LOG.info("Refreshing file: " + filePath);

            CompletableFuture.runAsync(() -> refreshFile(filePath));
        } catch (Exception e) {
            LOG.error("Failed to parse refresh_file request: " + e.getMessage(), e);
        }
    }

    private void refreshFile(String filePath) {
        try {
            File file = new File(filePath);

            try {
                TimeUnit.MILLISECONDS.sleep(300);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }

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

            File finalFile = file;
            EditorFileUtils.refreshAndFindFileAsync(
                    finalFile,
                    virtualFile -> performFileRefresh(virtualFile, filePath),
                    () -> LOG.error("Failed to refresh file: " + filePath)
            );
        } catch (Exception e) {
            LOG.error("Failed to refresh file: " + filePath, e);
        }
    }

    private void performFileRefresh(VirtualFile virtualFile, String filePath) {
        try {
            virtualFile.refresh(false, false);
            LOG.info("File refreshed successfully: " + filePath);
        } catch (Exception e) {
            LOG.error("Failed to perform file refresh: " + filePath, e);
        }
    }
}

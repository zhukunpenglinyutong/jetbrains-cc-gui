package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.EditorFileUtils;
import com.github.claudecodegui.util.WslPathUtil;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.nio.file.Path;
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
            String requestedPath = json.has("filePath") ? json.get("filePath").getAsString() : null;

            if (requestedPath == null || requestedPath.isEmpty()) {
                LOG.warn("refresh_file: filePath is empty");
                return;
            }

            String filePath = this.resolveFilePath(requestedPath, this.resolveWorkingDirectory());
            if (filePath == null) {
                LOG.warn("refresh_file: Cannot resolve a relative path without a working directory");
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

    private String resolveWorkingDirectory() {
        var session = this.context.getSession();
        String cwd = session == null ? null : session.getCwd();
        if (cwd != null && !cwd.isBlank()) {
            return cwd;
        }
        return this.context.getProject() == null ? null : this.context.getProject().getBasePath();
    }

    private String resolveFilePath(String filePath, String workingDirectory) {
        Path path = Path.of(WslPathUtil.toVfsPath(filePath));
        if (!path.isAbsolute()) {
            if (workingDirectory == null || workingDirectory.isBlank()) {
                return null;
            }
            path = Path.of(WslPathUtil.toVfsPath(workingDirectory)).resolve(path);
        }
        return path.normalize().toString();
    }

    void refreshFile(String filePath) {
        try {
            File file = new File(NodeDetector.toVfsPath(filePath));

            try {
                TimeUnit.MILLISECONDS.sleep(300);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }

            if (!file.exists()) {
                LOG.warn("File does not exist: " + filePath);
                return;
            }

            EditorFileUtils.refreshAndFindFileAsync(
                    file,
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

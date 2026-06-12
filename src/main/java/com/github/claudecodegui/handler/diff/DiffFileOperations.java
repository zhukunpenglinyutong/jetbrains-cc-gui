package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.util.WslPathUtil;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Shared file-system operations for diff handlers.
 */
public class DiffFileOperations {

    private static final Logger LOG = Logger.getInstance(DiffFileOperations.class);

    private final HandlerContext context;

    public DiffFileOperations(HandlerContext context) {
        this.context = context;
    }

    /** Check if a file path is within the project directory. Uses canonical paths to prevent path traversal. */
    public boolean isPathWithinProject(String filePath) {
        String projectBasePath = context.getProject().getBasePath();
        if (projectBasePath == null) {
            LOG.warn("Security: Cannot validate path - project base path is null");
            return false;
        }
        return WslPathUtil.isPathWithinDirectory(filePath, projectBasePath);
    }

    /**
     * Delete a file and refresh VFS.
     * Used when rejecting a newly created file to fully undo the creation.
     */
    public void deleteFile(String filePath) {
        if (!isPathWithinProject(filePath)) {
            LOG.warn("Security: Attempted to delete file outside project directory: " + filePath);
            return;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                VirtualFile file = LocalFileSystem.getInstance()
                        .refreshAndFindFileByPath(WslPathUtil.toVfsPath(filePath));
                if (file != null) {
                    ApplicationManager.getApplication().runWriteAction(() -> {
                        try {
                            file.delete(this);
                            LOG.info("File deleted (reject new file): " + filePath);
                        } catch (IOException e) {
                            LOG.error("Failed to delete file: " + filePath, e);
                        }
                    });
                } else {
                    File javaFile = new File(filePath);
                    if (javaFile.exists() && javaFile.delete()) {
                        LOG.info("File deleted via fallback (reject new file): " + filePath);
                    }
                }
            } catch (Exception e) {
                LOG.error("Failed to delete file: " + filePath, e);
            }
        });
    }

    /**
     * Write content to file and refresh VFS.
     * Validates that the file path is within the project directory for security.
     */
    public void writeContentToFile(String filePath, String content) {
        if (content == null) {
            return;
        }

        if (!isPathWithinProject(filePath)) {
            LOG.warn("Security: Attempted to write file outside project directory: " + filePath);
            return;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                VirtualFile file = LocalFileSystem.getInstance()
                        .refreshAndFindFileByPath(WslPathUtil.toVfsPath(filePath));

                if (file != null) {
                    Charset charset = file.getCharset() != null ? file.getCharset() : StandardCharsets.UTF_8;

                    ApplicationManager.getApplication().runWriteAction(() -> {
                        try {
                            file.setBinaryContent(content.getBytes(charset));
                            file.refresh(false, false);
                            LOG.info("File content written successfully: " + filePath);
                        } catch (IOException e) {
                            LOG.error("Failed to write file content: " + filePath, e);
                        }
                    });
                } else {
                    File javaFile = new File(filePath);
                    File parentDir = javaFile.getParentFile();
                    if (parentDir != null && !parentDir.exists() && !parentDir.mkdirs()) {
                        LOG.error("Failed to create parent directories: " + parentDir.getAbsolutePath());
                        return;
                    }
                    Files.write(javaFile.toPath(), content.getBytes(StandardCharsets.UTF_8));
                    LocalFileSystem.getInstance().refreshAndFindFileByPath(WslPathUtil.toVfsPath(filePath));
                    LOG.info("New file created: " + filePath);
                }
            } catch (Exception e) {
                LOG.error("Failed to write content to file: " + filePath, e);
            }
        });
    }
}

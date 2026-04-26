package com.github.claudecodegui.handler.diff;

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
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Shared file-system operations for diff handlers.
 */
public class DiffFileOperations {

    private static final Logger LOG = Logger.getInstance(DiffFileOperations.class);

    private final HandlerContext context;

    public DiffFileOperations(HandlerContext context) {
        this.context = context;
    }

    /**
     * Check if a file path is within the project directory.
     * Uses canonical paths to prevent path traversal attacks.
     */
    public boolean isPathWithinProject(String filePath) {
        if (filePath == null || filePath.isEmpty()) {
            return false;
        }
        String projectBasePath = context.getProject().getBasePath();
        if (projectBasePath == null) {
            LOG.warn("Security: Cannot validate path - project base path is null");
            return false;
        }
        try {
            String canonicalFilePath = new File(filePath).getCanonicalPath();
            String canonicalBasePath = new File(projectBasePath).getCanonicalPath();
            return canonicalFilePath.startsWith(canonicalBasePath + File.separator)
                    || canonicalFilePath.equals(canonicalBasePath);
        } catch (IOException e) {
            LOG.error("Failed to validate file path: " + filePath, e);
            return false;
        }
    }

    /**
     * Delete a file and refresh VFS.
     * Used when rejecting a newly created file to fully undo the creation.
     */
    public boolean deleteFile(String filePath) {
        if (!isPathWithinProject(filePath)) {
            LOG.warn("Security: Attempted to delete file outside project directory: " + filePath);
            return false;
        }

        AtomicBoolean success = new AtomicBoolean(false);
        AtomicReference<Exception> failure = new AtomicReference<>();
        runOnDispatchThreadAndWait(() -> {
            try {
                VirtualFile file = LocalFileSystem.getInstance()
                        .refreshAndFindFileByPath(filePath.replace('\\', '/'));
                if (file != null) {
                    ApplicationManager.getApplication().runWriteAction(() -> {
                        try {
                            file.delete(this);
                            success.set(true);
                            LOG.info("File deleted (reject new file): " + filePath);
                        } catch (IOException e) {
                            failure.set(e);
                        }
                    });
                } else {
                    File javaFile = new File(filePath);
                    if (!javaFile.exists()) {
                        success.set(true);
                    } else if (javaFile.delete()) {
                        success.set(true);
                        LOG.info("File deleted via fallback (reject new file): " + filePath);
                    } else {
                        failure.set(new IOException("Failed to delete file"));
                    }
                }
            } catch (Exception e) {
                failure.set(e);
            }
        });

        if (failure.get() != null) {
            LOG.error("Failed to delete file: " + filePath, failure.get());
        }
        return success.get() && failure.get() == null;
    }


    public Optional<String> readContentFromFile(String filePath) {
        if (!isPathWithinProject(filePath)) {
            LOG.warn("Security: Attempted to read file outside project directory: " + filePath);
            return Optional.empty();
        }
        try {
            VirtualFile file = LocalFileSystem.getInstance()
                    .refreshAndFindFileByPath(filePath.replace('\\', '/'));
            if (file != null) {
                Charset charset = file.getCharset() != null ? file.getCharset() : StandardCharsets.UTF_8;
                return Optional.of(new String(file.contentsToByteArray(), charset));
            }
            File javaFile = new File(filePath);
            if (!javaFile.exists()) {
                return Optional.empty();
            }
            return Optional.of(Files.readString(javaFile.toPath(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            LOG.error("Failed to read content from file: " + filePath, e);
            return Optional.empty();
        }
    }

    public boolean contentEquals(String filePath, String expectedContent) {
        Optional<String> current = readContentFromFile(filePath);
        return current.isPresent() && current.get().equals(expectedContent != null ? expectedContent : "");
    }

    /**
     * Write content to file and refresh VFS.
     * Validates that the file path is within the project directory for security.
     */
    public boolean writeContentToFile(String filePath, String content) {
        if (content == null) {
            return false;
        }

        if (!isPathWithinProject(filePath)) {
            LOG.warn("Security: Attempted to write file outside project directory: " + filePath);
            return false;
        }

        AtomicBoolean success = new AtomicBoolean(false);
        AtomicReference<Exception> failure = new AtomicReference<>();
        runOnDispatchThreadAndWait(() -> {
            try {
                VirtualFile file = LocalFileSystem.getInstance()
                        .refreshAndFindFileByPath(filePath.replace('\\', '/'));

                if (file != null) {
                    Charset charset = file.getCharset() != null ? file.getCharset() : StandardCharsets.UTF_8;

                    ApplicationManager.getApplication().runWriteAction(() -> {
                        try {
                            file.setBinaryContent(content.getBytes(charset));
                            file.refresh(false, false);
                            success.set(true);
                            LOG.info("File content written successfully: " + filePath);
                        } catch (IOException e) {
                            failure.set(e);
                        }
                    });
                } else {
                    File javaFile = new File(filePath);
                    File parentDir = javaFile.getParentFile();
                    if (parentDir != null && !parentDir.exists() && !parentDir.mkdirs()) {
                        failure.set(new IOException("Failed to create parent directories: " + parentDir.getAbsolutePath()));
                        return;
                    }
                    Files.write(javaFile.toPath(), content.getBytes(StandardCharsets.UTF_8));
                    LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath.replace('\\', '/'));
                    success.set(true);
                    LOG.info("New file created: " + filePath);
                }
            } catch (Exception e) {
                failure.set(e);
            }
        });

        if (failure.get() != null) {
            LOG.error("Failed to write content to file: " + filePath, failure.get());
        }
        return success.get() && failure.get() == null;
    }

    private void runOnDispatchThreadAndWait(Runnable runnable) {
        if (ApplicationManager.getApplication().isDispatchThread()) {
            runnable.run();
        } else {
            ApplicationManager.getApplication().invokeAndWait(runnable);
        }
    }
}

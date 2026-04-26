package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.encoding.EncodingProjectManager;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
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
        return resolveProjectPath(filePath).isPresent();
    }

    private Optional<Path> resolveProjectPath(String filePath) {
        if (filePath == null || filePath.isBlank()) {
            return Optional.empty();
        }
        String projectBasePath = context.getProject().getBasePath();
        if (projectBasePath == null) {
            LOG.warn("Security: Cannot validate path - project base path is null");
            return Optional.empty();
        }
        try {
            Path base = Path.of(projectBasePath).toRealPath().normalize();
            Path input = Path.of(filePath);
            Path requested = input.isAbsolute() ? input.normalize() : base.resolve(input).normalize();
            Path resolved = resolveExistingOrParent(requested);
            if (!isWithin(base, resolved)) {
                LOG.warn("Security: File path outside project directory: " + filePath + " (resolved: " + resolved + ")");
                return Optional.empty();
            }
            return Optional.of(resolved);
        } catch (IOException e) {
            LOG.error("Failed to validate file path: " + filePath, e);
            return Optional.empty();
        } catch (Exception e) {
            LOG.warn("Failed to validate file path: " + filePath, e);
            return Optional.empty();
        }
    }

    private static Path resolveExistingOrParent(Path requested) throws IOException {
        if (Files.exists(requested)) {
            return requested.toRealPath().normalize();
        }
        Path parent = requested.getParent();
        if (parent != null && Files.exists(parent)) {
            return parent.toRealPath().resolve(requested.getFileName()).normalize();
        }
        return requested.toAbsolutePath().normalize();
    }

    private static boolean isWithin(Path base, Path candidate) {
        Path normalizedBase = base.normalize();
        Path normalizedCandidate = candidate.normalize();
        if (isWindows()) {
            String baseText = normalizedBase.toString().toLowerCase(java.util.Locale.ROOT);
            String candidateText = normalizedCandidate.toString().toLowerCase(java.util.Locale.ROOT);
            return candidateText.equals(baseText) || candidateText.startsWith(baseText + java.io.File.separator);
        }
        return normalizedCandidate.startsWith(normalizedBase);
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win");
    }

    /**
     * Delete a file and refresh VFS.
     * Used when rejecting a newly created file to fully undo the creation.
     */
    public boolean deleteFile(String filePath) {
        Optional<Path> safePath = resolveProjectPath(filePath);
        if (safePath.isEmpty()) {
            LOG.warn("Security: Attempted to delete file outside project directory: " + filePath);
            return false;
        }
        String resolvedFilePath = safePath.get().toString();

        AtomicBoolean success = new AtomicBoolean(false);
        AtomicReference<Exception> failure = new AtomicReference<>();
        runOnDispatchThreadAndWait(() -> {
            try {
                VirtualFile file = LocalFileSystem.getInstance()
                        .refreshAndFindFileByPath(resolvedFilePath.replace('\\', '/'));
                if (file != null) {
                    ApplicationManager.getApplication().runWriteAction(() -> {
                        try {
                            file.delete(this);
                            success.set(true);
                            LOG.info("File deleted (reject new file): " + resolvedFilePath);
                        } catch (IOException e) {
                            failure.set(e);
                        }
                    });
                } else {
                    Path nioPath = safePath.get();
                    if (!Files.exists(nioPath)) {
                        success.set(true);
                    } else if (Files.deleteIfExists(nioPath)) {
                        success.set(true);
                        LOG.info("File deleted via fallback (reject new file): " + resolvedFilePath);
                    } else {
                        failure.set(new IOException("Failed to delete file"));
                    }
                }
            } catch (Exception e) {
                failure.set(e);
            }
        });

        if (failure.get() != null) {
            LOG.error("Failed to delete file: " + resolvedFilePath, failure.get());
        }
        return success.get() && failure.get() == null;
    }


    public Optional<String> readContentFromFile(String filePath) {
        Optional<Path> safePath = resolveProjectPath(filePath);
        if (safePath.isEmpty()) {
            LOG.warn("Security: Attempted to read file outside project directory: " + filePath);
            return Optional.empty();
        }
        String resolvedFilePath = safePath.get().toString();
        try {
            VirtualFile file = LocalFileSystem.getInstance()
                    .refreshAndFindFileByPath(resolvedFilePath.replace('\\', '/'));
            if (file != null) {
                Charset charset = file.getCharset() != null ? file.getCharset() : StandardCharsets.UTF_8;
                return Optional.of(new String(file.contentsToByteArray(), charset));
            }
            Path nioPath = safePath.get();
            if (!Files.exists(nioPath)) {
                return Optional.empty();
            }
            return Optional.of(Files.readString(nioPath, fallbackCharset()));
        } catch (Exception e) {
            LOG.error("Failed to read content from file: " + resolvedFilePath, e);
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

        Optional<Path> safePath = resolveProjectPath(filePath);
        if (safePath.isEmpty()) {
            LOG.warn("Security: Attempted to write file outside project directory: " + filePath);
            return false;
        }
        String resolvedFilePath = safePath.get().toString();

        AtomicBoolean success = new AtomicBoolean(false);
        AtomicReference<Exception> failure = new AtomicReference<>();
        runOnDispatchThreadAndWait(() -> {
            try {
                VirtualFile file = LocalFileSystem.getInstance()
                        .refreshAndFindFileByPath(resolvedFilePath.replace('\\', '/'));

                if (file != null) {
                    Charset charset = file.getCharset() != null ? file.getCharset() : StandardCharsets.UTF_8;

                    ApplicationManager.getApplication().runWriteAction(() -> {
                        try {
                            file.setBinaryContent(content.getBytes(charset));
                            file.refresh(false, false);
                            success.set(true);
                            LOG.info("File content written successfully: " + resolvedFilePath);
                        } catch (IOException e) {
                            failure.set(e);
                        }
                    });
                } else {
                    Path nioPath = safePath.get();
                    Path parentDir = nioPath.getParent();
                    if (parentDir != null) {
                        Files.createDirectories(parentDir);
                    }
                    Optional<Path> validatedAfterParent = resolveProjectPath(nioPath.toString());
                    if (validatedAfterParent.isEmpty()) {
                        failure.set(new IOException("Resolved path escaped project after creating parent directories"));
                        return;
                    }
                    Path target = validatedAfterParent.get();
                    Path temp = Files.createTempFile(target.getParent(), target.getFileName().toString(), ".tmp");
                    try {
                        Files.write(temp, content.getBytes(fallbackCharset()));
                        Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                    } catch (IOException atomicMoveFailure) {
                        Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
                    } finally {
                        Files.deleteIfExists(temp);
                    }
                    LocalFileSystem.getInstance().refreshAndFindFileByPath(target.toString().replace('\\', '/'));
                    success.set(true);
                    LOG.info("New file created: " + target);
                }
            } catch (Exception e) {
                failure.set(e);
            }
        });

        if (failure.get() != null) {
            LOG.error("Failed to write content to file: " + resolvedFilePath, failure.get());
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

    private Charset fallbackCharset() {
        Charset charset = EncodingProjectManager.getInstance(context.getProject()).getDefaultCharset();
        return charset != null ? charset : StandardCharsets.UTF_8;
    }
}

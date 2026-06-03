package com.github.claudecodegui.util;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.application.PathManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;

/**
 * Persists optional streaming debug output next to the IDE log files.
 */
public final class StreamDebugLogService {

    private static final Logger LOG = Logger.getInstance(StreamDebugLogService.class);
    private static final String LOG_FILE_NAME = "codemoss-stream-debug.log";
    private static final long MAX_LOG_BYTES = 20L * 1024L * 1024L;

    private StreamDebugLogService() {
    }

    public static Path getLogFilePath() {
        return Paths.get(PathManager.getLogPath(), LOG_FILE_NAME);
    }

    public static synchronized void appendLine(String line) {
        if (line == null || line.isEmpty()) {
            return;
        }
        try {
            ensureLogFileExists();
            Files.writeString(
                    getLogFilePath(),
                    line + System.lineSeparator(),
                    StandardCharsets.UTF_8,
                    StandardOpenOption.APPEND
            );
        } catch (Exception e) {
            LOG.debug("Failed to append stream debug log: " + e.getMessage());
        }
    }

    public static void ensureLogFileExists() throws IOException {
        Path logPath = getLogFilePath();
        Path parent = logPath.getParent();
        if (parent != null && !Files.exists(parent)) {
            Files.createDirectories(parent);
        }
        if (!Files.exists(logPath)) {
            Files.writeString(
                    logPath,
                    "# Codemoss streaming debug log" + System.lineSeparator(),
                    StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE_NEW
            );
        } else if (Files.size(logPath) > MAX_LOG_BYTES) {
            Files.writeString(
                    logPath,
                    "# Codemoss streaming debug log truncated after exceeding "
                            + MAX_LOG_BYTES + " bytes" + System.lineSeparator(),
                    StandardCharsets.UTF_8,
                    StandardOpenOption.TRUNCATE_EXISTING
            );
        }
    }

    public static void openLogFile(Project project) {
        if (project == null || project.isDisposed()) {
            return;
        }
        try {
            ensureLogFileExists();
            final String absolutePath = getLogFilePath().toAbsolutePath().toString();
            ApplicationManager.getApplication().invokeLater(() -> {
                if (project.isDisposed()) {
                    return;
                }
                VirtualFile virtualFile = LocalFileSystem.getInstance().findFileByPath(absolutePath);
                if (virtualFile == null) {
                    virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByPath(absolutePath);
                }
                if (virtualFile != null) {
                    FileEditorManager.getInstance(project).openFile(virtualFile, true);
                } else {
                    LOG.warn("Stream debug log file not found: " + absolutePath);
                }
            }, ModalityState.nonModal());
        } catch (Exception e) {
            LOG.warn("Failed to open stream debug log: " + e.getMessage());
        }
    }
}

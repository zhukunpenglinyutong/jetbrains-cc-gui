package com.github.claudecodegui.permission;

import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.IOException;
import java.nio.file.*;
import java.util.function.BiConsumer;

import static java.nio.file.StandardWatchEventKinds.*;

/**
 * Watches the permission directory and dispatches session-scoped request files.
 * Uses WatchService for efficient filesystem event detection instead of polling.
 */
class PermissionRequestWatcher {

    interface RequestHandler {
        void handlePermissionRequest(Path requestFile);

        void handleAskUserQuestionRequest(Path requestFile);

        void handlePlanApprovalRequest(Path requestFile);
    }

    private static final Logger LOG = Logger.getInstance(PermissionRequestWatcher.class);
    private static final int ERROR_RETRY_DELAY_MS = 1000;

    private final Path permissionDir;
    private final String sessionId;
    private final PermissionFileProtocol fileProtocol;
    private final BiConsumer<String, String> debugLog;

    private volatile boolean running;
    private Thread watchThread;
    private WatchService watchService;

    PermissionRequestWatcher(
            Path permissionDir,
            String sessionId,
            PermissionFileProtocol fileProtocol,
            BiConsumer<String, String> debugLog
    ) {
        this.permissionDir = permissionDir;
        this.sessionId = sessionId;
        this.fileProtocol = fileProtocol;
        this.debugLog = debugLog;
    }

    void start(RequestHandler handler) {
        if (running) {
            debugLog.accept("START", "Already running, skipping start");
            return;
        }

        fileProtocol.cleanupSessionFiles();
        running = true;
        watchThread = new Thread(() -> watchLoop(handler), "PermissionWatcher-" + sessionId);
        watchThread.setDaemon(true);
        watchThread.start();

        debugLog.accept("START", "Started watching on: " + permissionDir);
    }

    void stop() {
        running = false;
        if (watchService != null) {
            try {
                watchService.close();
            } catch (IOException e) {
                LOG.warn("Error closing WatchService", e);
            }
        }
        if (watchThread != null) {
            watchThread.interrupt();
            try {
                watchThread.join(1000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                LOG.error("Error occurred", e);
            }
        }
    }

    private void watchLoop(RequestHandler handler) {
        debugLog.accept("WATCH_LOOP", "Starting watch loop on: " + permissionDir);

        // Register WatchService
        try {
            File dir = permissionDir.toFile();
            if (!dir.exists()) {
                dir.mkdirs();
            }
            watchService = FileSystems.getDefault().newWatchService();
            permissionDir.register(watchService, ENTRY_CREATE, ENTRY_MODIFY);
        } catch (IOException e) {
            debugLog.accept("WATCH_ERROR", "Failed to register WatchService: " + e.getMessage());
            LOG.error("Failed to register WatchService", e);
            running = false;
            return;
        }

        // Initial scan of existing files (matches old polling behavior on first iteration)
        scanForFiles(handler);

        while (running) {
            try {
                WatchKey key = watchService.take();

                // Drain all pending events
                boolean hasEvents = false;
                for (WatchEvent<?> event : key.pollEvents()) {
                    hasEvents = true;
                    debugLog.accept("WATCH_EVENT", "Event kind: " + event.kind() + ", context: " + event.context());
                }
                key.reset();

                if (hasEvents) {
                    scanForFiles(handler);
                }
            } catch (ClosedWatchServiceException e) {
                // Expected during stop() - clean shutdown
                debugLog.accept("WATCH_LOOP", "WatchService closed, exiting loop");
                break;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                debugLog.accept("WATCH_ERROR", "Error in watch loop: " + e.getMessage());
                LOG.error("Error occurred", e);
                try {
                    Thread.sleep(ERROR_RETRY_DELAY_MS);
                } catch (InterruptedException ex) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        debugLog.accept("WATCH_LOOP", "Watch loop ended");
    }

    private void scanForFiles(RequestHandler handler) {
        try {
            File dir = permissionDir.toFile();
            if (!dir.exists()) {
                dir.mkdirs();
            }

            File[] requestFiles = fileProtocol.listPermissionRequestFiles();
            File[] askUserQuestionFiles = fileProtocol.listAskUserQuestionRequestFiles();
            File[] planApprovalFiles = fileProtocol.listPlanApprovalRequestFiles();

            debugLog.accept("SCAN_STATUS", String.format(
                    "Scanned, found %d request files, %d ask-user-question files, %d plan-approval files",
                    requestFiles.length,
                    askUserQuestionFiles.length,
                    planApprovalFiles.length
            ));

            dispatchFiles(requestFiles, "REQUEST_FOUND", handler::handlePermissionRequest);
            dispatchFiles(askUserQuestionFiles, "ASK_USER_QUESTION_FOUND", handler::handleAskUserQuestionRequest);
            dispatchFiles(planApprovalFiles, "PLAN_APPROVAL_FOUND", handler::handlePlanApprovalRequest);
        } catch (Exception e) {
            debugLog.accept("SCAN_ERROR", "Error scanning files: " + e.getMessage());
            LOG.error("Error occurred", e);
        }
    }

    private void dispatchFiles(File[] files, String tag, java.util.function.Consumer<Path> consumer) {
        for (File file : files) {
            if (!file.exists()) {
                continue;
            }
            debugLog.accept(tag, "Found request file: " + file.getName());
            consumer.accept(file.toPath());
        }
    }
}

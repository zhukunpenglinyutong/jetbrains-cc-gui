package com.github.claudecodegui.permission;

import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.nio.file.Path;
import java.util.function.BiConsumer;

/**
 * Polls the permission directory and dispatches session-scoped request files.
 */
class PermissionRequestWatcher {

    interface RequestHandler {
        void handlePermissionRequest(Path requestFile);

        void handleAskUserQuestionRequest(Path requestFile);

        void handlePlanApprovalRequest(Path requestFile);
    }

    private static final Logger LOG = Logger.getInstance(PermissionRequestWatcher.class);
    private static final int POLL_INTERVAL_MS = 500;
    private static final int ERROR_RETRY_DELAY_MS = 1000;

    private final Path permissionDir;
    private final String sessionId;
    private final PermissionFileProtocol fileProtocol;
    private final BiConsumer<String, String> debugLog;

    private volatile boolean running;
    private Thread watchThread;

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

        debugLog.accept("START", "Started polling on: " + permissionDir);
    }

    void stop() {
        running = false;
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
        debugLog.accept("WATCH_LOOP", "Starting polling loop on: " + permissionDir);
        int pollCount = 0;
        while (running) {
            try {
                pollCount++;
                File dir = permissionDir.toFile();
                if (!dir.exists()) {
                    dir.mkdirs();
                }

                File[] requestFiles = fileProtocol.listPermissionRequestFiles();
                File[] askUserQuestionFiles = fileProtocol.listAskUserQuestionRequestFiles();
                File[] planApprovalFiles = fileProtocol.listPlanApprovalRequestFiles();

                if (pollCount % 100 == 0) {
                    debugLog.accept("POLL_STATUS", String.format(
                            "Poll #%d, found %d request files, %d ask-user-question files, %d plan-approval files",
                            pollCount,
                            requestFiles.length,
                            askUserQuestionFiles.length,
                            planApprovalFiles.length
                    ));
                }

                dispatchFiles(requestFiles, "REQUEST_FOUND", handler::handlePermissionRequest);
                dispatchFiles(askUserQuestionFiles, "ASK_USER_QUESTION_FOUND", handler::handleAskUserQuestionRequest);
                dispatchFiles(planApprovalFiles, "PLAN_APPROVAL_FOUND", handler::handlePlanApprovalRequest);

                Thread.sleep(POLL_INTERVAL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                debugLog.accept("POLL_ERROR", "Error in poll loop: " + e.getMessage());
                LOG.error("Error occurred", e);
                try {
                    Thread.sleep(ERROR_RETRY_DELAY_MS);
                } catch (InterruptedException ex) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        debugLog.accept("WATCH_LOOP", "Polling loop ended");
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

package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * F-007: File-based diagnostic snapshot trigger.
 * Watches ~/.codemoss/diagnostics/ for a "snapshot-request" file.
 * When detected, reads optional bugId from file content, deletes the file,
 * and calls window.collectDiagnosticSnapshot(bugId) on the webview.
 *
 * All running instances react simultaneously (cross-instance trigger).
 */
public class DiagnosticFileWatcher {

    private static final Logger LOG = Logger.getInstance(DiagnosticFileWatcher.class);
    private static final String TRIGGER_FILENAME = "snapshot-request";

    private final HandlerContext context;
    private final Path watchDir;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private Thread watcherThread;

    public DiagnosticFileWatcher(HandlerContext context) {
        this.context = context;
        this.watchDir = Paths.get(PlatformUtils.getHomeDirectory(), ".codemoss", "diagnostics");
    }

    /**
     * Start watching for snapshot-request files.
     * Safe to call multiple times; only starts once.
     */
    public synchronized void start() {
        if (running.get()) return;

        try {
            Files.createDirectories(watchDir);
        } catch (IOException e) {
            LOG.warn("[DiagnosticFileWatcher] Cannot create watch directory: " + e.getMessage());
            return;
        }

        running.set(true);
        watcherThread = new Thread(this::watchLoop, "DiagnosticFileWatcher");
        watcherThread.setDaemon(true);
        watcherThread.start();
        LOG.info("[DiagnosticFileWatcher] Started watching: " + watchDir);
    }

    /**
     * Stop the watcher thread.
     */
    public synchronized void stop() {
        running.set(false);
        if (watcherThread != null) {
            watcherThread.interrupt();
            watcherThread = null;
        }
        LOG.info("[DiagnosticFileWatcher] Stopped");
    }

    private void watchLoop() {
        try (WatchService watchService = FileSystems.getDefault().newWatchService()) {
            watchDir.register(watchService, StandardWatchEventKinds.ENTRY_CREATE);

            // Also check if trigger file already exists on start
            checkAndProcessTriggerFile();

            while (running.get() && !Thread.currentThread().isInterrupted()) {
                WatchKey key;
                try {
                    key = watchService.poll(2, java.util.concurrent.TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }

                if (key == null) continue;

                for (WatchEvent<?> event : key.pollEvents()) {
                    if (event.kind() == StandardWatchEventKinds.OVERFLOW) continue;

                    @SuppressWarnings("unchecked")
                    WatchEvent<Path> pathEvent = (WatchEvent<Path>) event;
                    Path fileName = pathEvent.context();

                    if (TRIGGER_FILENAME.equals(fileName.toString())) {
                        // Small delay to ensure file is fully written
                        try {
                            Thread.sleep(100);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            break;
                        }
                        checkAndProcessTriggerFile();
                    }
                }

                boolean valid = key.reset();
                if (!valid) {
                    LOG.warn("[DiagnosticFileWatcher] Watch key invalidated, stopping");
                    break;
                }
            }
        } catch (IOException e) {
            if (running.get()) {
                LOG.error("[DiagnosticFileWatcher] Watch service error: " + e.getMessage(), e);
            }
        }
    }

    private void checkAndProcessTriggerFile() {
        Path triggerFile = watchDir.resolve(TRIGGER_FILENAME);
        if (!Files.exists(triggerFile)) return;

        try {
            // Read optional bugId from file content
            String content = Files.readString(triggerFile, StandardCharsets.UTF_8).trim();
            String bugId = content.isEmpty() ? "MANUAL" : content;

            // Delete trigger file before triggering (other instances will also see and process it)
            try {
                Files.deleteIfExists(triggerFile);
            } catch (IOException e) {
                LOG.warn("[DiagnosticFileWatcher] Could not delete trigger file: " + e.getMessage());
            }

            LOG.info("[DiagnosticFileWatcher] Trigger detected, bugId=" + bugId);

            // Call webview to collect snapshot
            String escapedBugId = context.escapeJs(bugId);
            context.executeJavaScriptOnEDT(
                "if(window.collectDiagnosticSnapshot){window.collectDiagnosticSnapshot('" + escapedBugId + "');}"
            );

        } catch (IOException e) {
            LOG.error("[DiagnosticFileWatcher] Error reading trigger file: " + e.getMessage(), e);
        }
    }
}

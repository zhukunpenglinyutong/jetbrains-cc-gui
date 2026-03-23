package com.github.claudecodegui.diagnostics;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * F-010: Asynchronous IPC traffic logger.
 * Writes JSON Lines (NDJSON) to ~/.codemoss/diagnostics/ipc-sniffer/.
 * Uses a bounded queue + single writer thread to avoid blocking the IPC path.
 */
public class IpcSnifferWriter {

    private static final Logger LOG = Logger.getInstance(IpcSnifferWriter.class);
    private static final Gson GSON = new Gson();

    private static final int QUEUE_CAPACITY = 10_000;
    private static final long MAX_FILE_BYTES = 50L * 1024 * 1024; // 50 MB safety valve
    private static final int FLUSH_INTERVAL_LINES = 100;
    private static final long CLEANUP_AGE_DAYS = 7;

    private static final DateTimeFormatter TS_FORMAT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS");
    private static final DateTimeFormatter FILE_TS_FORMAT =
            DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    private final Path directory;
    private final LinkedBlockingQueue<String> queue = new LinkedBlockingQueue<>(QUEUE_CAPACITY);
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile Thread writerThread;
    private volatile BufferedWriter currentWriter;
    private volatile Path currentFile;
    private volatile long currentFileBytes;

    public IpcSnifferWriter(Path directory) {
        this.directory = directory;
        try {
            Files.createDirectories(directory);
            cleanupOldFiles();
        } catch (IOException e) {
            LOG.warn("[IpcSniffer] Failed to create directory: " + directory, e);
        }
        startWriterThread();
    }

    /**
     * Log an outbound message (Java → ai-bridge).
     */
    public void logOutbound(String sessionId, String channelId, String model,
                            String mode, String sanitizedPayload) {
        if (!running.get()) return;

        JsonObject entry = new JsonObject();
        entry.addProperty("ts", now());
        entry.addProperty("dir", "OUT");
        if (sessionId != null) entry.addProperty("sid", sessionId);
        if (channelId != null) entry.addProperty("ch", channelId);
        if (model != null) entry.addProperty("model", model);
        entry.addProperty("mode", mode);
        entry.addProperty("size", sanitizedPayload.length());
        // Parse payload as JSON object for structured logging
        try {
            entry.add("payload", GSON.fromJson(sanitizedPayload, JsonObject.class));
        } catch (Exception e) {
            entry.addProperty("payload", sanitizedPayload);
        }

        ensureFileOpen(sessionId);
        queue.offer(GSON.toJson(entry));
    }

    /**
     * Log an inbound line (ai-bridge → Java).
     */
    public void logInbound(String sessionId, String line) {
        if (!running.get()) return;

        JsonObject entry = new JsonObject();
        entry.addProperty("ts", now());
        entry.addProperty("dir", "IN");
        if (sessionId != null) entry.addProperty("sid", sessionId);

        // Extract tag for easy filtering
        String tag = extractTag(line);
        if (tag != null) entry.addProperty("tag", tag);
        entry.addProperty("line", line);

        queue.offer(GSON.toJson(entry));
    }

    /**
     * F-012: Log a lifecycle event (webview_created, page_loaded, session_start, etc.)
     */
    public void logLifecycle(String event, String detail) {
        if (!running.get()) return;

        JsonObject entry = new JsonObject();
        entry.addProperty("ts", now());
        entry.addProperty("dir", "LIFECYCLE");
        entry.addProperty("event", event);
        if (detail != null) entry.addProperty("detail", detail);

        queue.offer(GSON.toJson(entry));
    }

    /**
     * Close current file and stop accepting new entries.
     */
    public void shutdown() {
        running.set(false);
        if (writerThread != null) {
            writerThread.interrupt();
            try {
                writerThread.join(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        closeCurrentWriter();
    }

    // ========================================================================
    // Internal
    // ========================================================================

    private void startWriterThread() {
        running.set(true);
        writerThread = new Thread(() -> {
            int linesSinceFlush = 0;
            long lastFlushTime = System.currentTimeMillis();

            while (running.get() || !queue.isEmpty()) {
                try {
                    String entry = queue.poll(500, java.util.concurrent.TimeUnit.MILLISECONDS);
                    if (entry == null) {
                        // Timeout — flush if there's pending data
                        flushQuietly();
                        lastFlushTime = System.currentTimeMillis();
                        linesSinceFlush = 0;
                        continue;
                    }

                    writeEntry(entry);
                    linesSinceFlush++;

                    // Flush periodically
                    if (linesSinceFlush >= FLUSH_INTERVAL_LINES
                            || System.currentTimeMillis() - lastFlushTime > 500) {
                        flushQuietly();
                        lastFlushTime = System.currentTimeMillis();
                        linesSinceFlush = 0;
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }

            // Drain remaining
            String remaining;
            while ((remaining = queue.poll()) != null) {
                writeEntry(remaining);
            }
            flushQuietly();
            closeCurrentWriter();
        }, "ipc-sniffer-writer");
        writerThread.setDaemon(true);
        writerThread.start();
    }

    private void ensureFileOpen(String sessionId) {
        if (currentWriter != null) return;

        try {
            String prefix = sessionId != null && sessionId.length() >= 8
                    ? sessionId.substring(0, 8) : "unknown";
            String ts = LocalDateTime.now().format(FILE_TS_FORMAT);
            String fileName = "ipc-" + prefix + "-" + ts + ".jsonl";
            currentFile = directory.resolve(fileName);
            currentWriter = Files.newBufferedWriter(currentFile, StandardCharsets.UTF_8);
            currentFileBytes = 0;
            LOG.info("[IpcSniffer] Opened log file: " + currentFile.getFileName());
        } catch (IOException e) {
            LOG.warn("[IpcSniffer] Failed to open log file", e);
            currentWriter = null;
        }
    }

    private void writeEntry(String jsonLine) {
        BufferedWriter writer = currentWriter;
        if (writer == null) return;

        // Safety valve: stop writing if file gets too large
        if (currentFileBytes > MAX_FILE_BYTES) return;

        try {
            writer.write(jsonLine);
            writer.newLine();
            currentFileBytes += jsonLine.length() + 1;
        } catch (IOException e) {
            LOG.debug("[IpcSniffer] Write failed: " + e.getMessage());
        }
    }

    private void flushQuietly() {
        BufferedWriter writer = currentWriter;
        if (writer != null) {
            try {
                writer.flush();
            } catch (IOException e) {
                LOG.debug("[IpcSniffer] Flush failed: " + e.getMessage());
            }
        }
    }

    /**
     * Close the current log file.
     * Called between sessions or on shutdown.
     */
    public void closeCurrentWriter() {
        BufferedWriter writer = currentWriter;
        currentWriter = null;
        if (writer != null) {
            try {
                writer.close();
                if (currentFile != null) {
                    LOG.info("[IpcSniffer] Closed log file: " + currentFile.getFileName()
                            + " (" + (currentFileBytes / 1024) + " KB)");
                }
            } catch (IOException e) {
                LOG.debug("[IpcSniffer] Close failed: " + e.getMessage());
            }
        }
    }

    private void cleanupOldFiles() {
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(directory, "ipc-*.jsonl")) {
            Instant cutoff = Instant.now().minus(CLEANUP_AGE_DAYS, ChronoUnit.DAYS);
            for (Path file : stream) {
                try {
                    Instant modified = Files.getLastModifiedTime(file).toInstant();
                    if (modified.isBefore(cutoff)) {
                        Files.deleteIfExists(file);
                        LOG.info("[IpcSniffer] Cleaned up old file: " + file.getFileName());
                    }
                } catch (IOException e) {
                    // Skip individual file errors
                }
            }
        } catch (IOException e) {
            LOG.debug("[IpcSniffer] Cleanup failed: " + e.getMessage());
        }
    }

    private static String now() {
        return LocalDateTime.now().format(TS_FORMAT);
    }

    /**
     * Extract the tag name from a tagged IPC line (e.g. "[CONTENT_DELTA]" → "CONTENT_DELTA").
     */
    private static String extractTag(String line) {
        if (line == null || !line.startsWith("[")) return null;
        int end = line.indexOf(']');
        if (end > 1) {
            return line.substring(1, end);
        }
        return null;
    }
}

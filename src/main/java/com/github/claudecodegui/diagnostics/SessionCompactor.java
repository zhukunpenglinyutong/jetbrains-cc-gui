package com.github.claudecodegui.diagnostics;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.PlatformUtils;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;
import java.util.Set;

/**
 * Session JSONL compactor.
 * Reads a session's JSONL file, removes non-essential entries (progress events,
 * old file-history-snapshots, etc.), and keeps only the last N user/assistant messages.
 * Creates a .bak-compact backup before overwriting.
 */
public class SessionCompactor {

    private static final Logger LOG = Logger.getInstance(SessionCompactor.class);
    private static final Gson GSON = new Gson();

    private static final int DEFAULT_KEEP_MESSAGES = 200;

    private static final Path PROJECTS_DIR = Paths.get(
            PlatformUtils.getHomeDirectory(), ".claude", "projects");

    /**
     * Types that are always dropped during compaction.
     * These are progress/status events that are never needed for session replay.
     */
    private static final Set<String> DROP_TYPES = Set.of(
            "progress",
            "bash_progress",
            "agent_progress",
            "hook_progress"
    );

    // ========================================================================
    // Public API
    // ========================================================================

    public static CompactResult compact(String sessionId, String cwd) {
        return compact(sessionId, cwd, DEFAULT_KEEP_MESSAGES);
    }

    public static CompactResult compact(String sessionId, String cwd, int keepMessages) {
        if (sessionId == null || sessionId.isEmpty()) {
            return CompactResult.error("sessionId is null or empty");
        }
        if (cwd == null || cwd.isEmpty()) {
            return CompactResult.error("cwd is null or empty");
        }

        Path sessionFile = resolveSessionFile(sessionId, cwd);
        if (sessionFile == null || !Files.exists(sessionFile)) {
            return CompactResult.error("Session file not found: " + sessionId);
        }

        try {
            long originalSize = Files.size(sessionFile);

            // 1. Read all lines
            List<String> allLines = Files.readAllLines(sessionFile, StandardCharsets.UTF_8);
            if (allLines.isEmpty()) {
                return CompactResult.error("Session file is empty");
            }

            // 2. Classify lines
            List<IndexedLine> queueOps = new ArrayList<>();
            LinkedList<IndexedLine> messages = new LinkedList<>();  // user + assistant
            List<IndexedLine> fileHistorySnapshots = new ArrayList<>();
            List<IndexedLine> otherKeep = new ArrayList<>();
            int droppedCount = 0;

            for (int i = 0; i < allLines.size(); i++) {
                String line = allLines.get(i);
                if (line.isBlank()) continue;

                String type = extractType(line);
                if (type == null) {
                    // Can't parse — keep it to be safe
                    otherKeep.add(new IndexedLine(i, line));
                    continue;
                }

                if (DROP_TYPES.contains(type)) {
                    droppedCount++;
                    continue;
                }

                if ("queue-operation".equals(type)) {
                    queueOps.add(new IndexedLine(i, line));
                    continue;
                }

                if ("user".equals(type) || "assistant".equals(type)) {
                    messages.add(new IndexedLine(i, line));
                    continue;
                }

                if ("file-history-snapshot".equals(type)) {
                    fileHistorySnapshots.add(new IndexedLine(i, line));
                    continue;
                }

                // Unknown type — keep it
                otherKeep.add(new IndexedLine(i, line));
            }

            // 3. Build compacted output
            List<String> compacted = new ArrayList<>();

            // Keep first queue-operation (session init)
            if (!queueOps.isEmpty()) {
                compacted.add(queueOps.get(0).line);
                droppedCount += queueOps.size() - 1;
            }

            // Keep last file-history-snapshot only
            if (!fileHistorySnapshots.isEmpty()) {
                compacted.add(fileHistorySnapshots.get(fileHistorySnapshots.size() - 1).line);
                droppedCount += fileHistorySnapshots.size() - 1;
            }

            // Keep other (unknown) types
            for (IndexedLine il : otherKeep) {
                compacted.add(il.line);
            }

            // Keep last N messages
            int messagesToDrop = Math.max(0, messages.size() - keepMessages);
            droppedCount += messagesToDrop;
            List<IndexedLine> keptMessages = messages.subList(messagesToDrop, messages.size());
            for (IndexedLine il : keptMessages) {
                compacted.add(il.line);
            }

            // 4. Backup (only if no backup exists yet)
            Path backupFile = sessionFile.resolveSibling(sessionFile.getFileName() + ".bak-compact");
            if (!Files.exists(backupFile)) {
                Files.copy(sessionFile, backupFile, StandardCopyOption.COPY_ATTRIBUTES);
                LOG.info("[SessionCompactor] Backup created: " + backupFile.getFileName());
            }

            // 5. Write compacted file
            try (BufferedWriter writer = Files.newBufferedWriter(sessionFile, StandardCharsets.UTF_8)) {
                for (String line : compacted) {
                    writer.write(line);
                    writer.newLine();
                }
            }

            long compactedSize = Files.size(sessionFile);
            int messagesKept = keptMessages.size();

            LOG.info("[SessionCompactor] Compacted " + sessionId.substring(0, 8) + ": "
                    + (originalSize / 1024) + " KB -> " + (compactedSize / 1024) + " KB, "
                    + messagesKept + " messages kept, " + droppedCount + " entries dropped");

            return CompactResult.success(originalSize, compactedSize, messagesKept, droppedCount);

        } catch (IOException e) {
            LOG.warn("[SessionCompactor] Failed to compact session: " + sessionId, e);
            return CompactResult.error("IO error: " + e.getMessage());
        } catch (Exception e) {
            LOG.warn("[SessionCompactor] Unexpected error compacting session: " + sessionId, e);
            return CompactResult.error("Unexpected error: " + e.getMessage());
        }
    }

    // ========================================================================
    // Path resolution (same as ClaudeHistoryReader)
    // ========================================================================

    static Path resolveSessionFile(String sessionId, String cwd) {
        String sanitized = PathUtils.sanitizePath(cwd);
        Path projectDir = PROJECTS_DIR.resolve(sanitized);
        return projectDir.resolve(sessionId + ".jsonl");
    }

    // ========================================================================
    // JSON helpers
    // ========================================================================

    private static String extractType(String jsonLine) {
        try {
            JsonElement el = GSON.fromJson(jsonLine, JsonElement.class);
            if (el != null && el.isJsonObject()) {
                JsonObject obj = el.getAsJsonObject();
                if (obj.has("type")) {
                    return obj.get("type").getAsString();
                }
            }
        } catch (Exception e) {
            // malformed JSON — treat as unknown
        }
        return null;
    }

    // ========================================================================
    // Internal types
    // ========================================================================

    private static class IndexedLine {
        final int index;
        final String line;

        IndexedLine(int index, String line) {
            this.index = index;
            this.line = line;
        }
    }

    /**
     * Result of a compact operation.
     */
    public static class CompactResult {
        public final boolean success;
        public final long originalSize;
        public final long compactedSize;
        public final int messagesKept;
        public final int messagesDropped;
        public final String error;

        private CompactResult(boolean success, long originalSize, long compactedSize,
                              int messagesKept, int messagesDropped, String error) {
            this.success = success;
            this.originalSize = originalSize;
            this.compactedSize = compactedSize;
            this.messagesKept = messagesKept;
            this.messagesDropped = messagesDropped;
            this.error = error;
        }

        public static CompactResult success(long originalSize, long compactedSize,
                                            int messagesKept, int messagesDropped) {
            return new CompactResult(true, originalSize, compactedSize,
                    messagesKept, messagesDropped, null);
        }

        public static CompactResult error(String error) {
            return new CompactResult(false, 0, 0, 0, 0, error);
        }

        public String toJson() {
            JsonObject obj = new JsonObject();
            obj.addProperty("success", success);
            if (success) {
                obj.addProperty("originalSize", originalSize);
                obj.addProperty("compactedSize", compactedSize);
                obj.addProperty("messagesKept", messagesKept);
                obj.addProperty("messagesDropped", messagesDropped);
            } else {
                obj.addProperty("error", error);
            }
            return new Gson().toJson(obj);
        }
    }
}

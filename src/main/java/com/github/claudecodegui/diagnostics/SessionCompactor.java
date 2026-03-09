package com.github.claudecodegui.diagnostics;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.PlatformUtils;

import com.google.gson.JsonArray;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
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

            // 3. Build tool_use/tool_result dependency map
            // Maps tool_use_id -> index in messages list (for assistant messages with tool_use)
            Map<String, Integer> toolUseIdToMessageIndex = new HashMap<>();
            // Maps message index -> set of tool_use_ids referenced (for user messages with tool_result)
            Map<Integer, Set<String>> messageIndexToToolResultIds = new HashMap<>();

            for (int i = 0; i < messages.size(); i++) {
                IndexedLine il = messages.get(i);
                String type = extractType(il.line);

                if ("assistant".equals(type)) {
                    // Extract all tool_use ids from this assistant message
                    Set<String> toolUseIds = extractToolUseIds(il.line);
                    for (String id : toolUseIds) {
                        toolUseIdToMessageIndex.put(id, i);
                    }
                } else if ("user".equals(type)) {
                    // Extract all tool_result ids from this user message
                    Set<String> toolResultIds = extractToolResultIds(il.line);
                    if (!toolResultIds.isEmpty()) {
                        messageIndexToToolResultIds.put(i, toolResultIds);
                    }
                }
            }

            // 4. Determine cutoff, ensuring tool_use/tool_result pairs stay together
            int initialCutoff = Math.max(0, messages.size() - keepMessages);
            int adjustedCutoff = initialCutoff;

            // Check if any tool_result after cutoff references a tool_use before cutoff
            for (int i = initialCutoff; i < messages.size(); i++) {
                Set<String> referencedIds = messageIndexToToolResultIds.get(i);
                if (referencedIds != null) {
                    for (String toolUseId : referencedIds) {
                        Integer toolUseMessageIndex = toolUseIdToMessageIndex.get(toolUseId);
                        if (toolUseMessageIndex != null && toolUseMessageIndex < adjustedCutoff) {
                            // This tool_result references a tool_use that would be dropped
                            // Move cutoff back to include the tool_use
                            adjustedCutoff = toolUseMessageIndex;
                            LOG.info("[SessionCompactor] Adjusted cutoff from " + initialCutoff
                                    + " to " + adjustedCutoff + " to preserve tool_use/tool_result pair: " + toolUseId);
                        }
                    }
                }
            }

            // 5. Build compacted output
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

            // Keep messages from adjusted cutoff
            droppedCount += adjustedCutoff;
            List<IndexedLine> keptMessages = messages.subList(adjustedCutoff, messages.size());
            for (IndexedLine il : keptMessages) {
                compacted.add(il.line);
            }

            // 6. Post-compact validation: ensure no orphaned tool_results
            Set<String> keptToolUseIds = new HashSet<>();
            Set<String> keptToolResultIds = new HashSet<>();
            for (IndexedLine il : keptMessages) {
                keptToolUseIds.addAll(extractToolUseIds(il.line));
                keptToolResultIds.addAll(extractToolResultIds(il.line));
            }
            Set<String> orphanedToolResults = new HashSet<>(keptToolResultIds);
            orphanedToolResults.removeAll(keptToolUseIds);
            if (!orphanedToolResults.isEmpty()) {
                LOG.warn("[SessionCompactor] VALIDATION FAILED: " + orphanedToolResults.size()
                        + " orphaned tool_result(s) detected: " + orphanedToolResults);
                // This should not happen with the adjusted cutoff logic above,
                // but if it does, we abort to avoid corrupting the session
                return CompactResult.error("Validation failed: orphaned tool_results detected");
            }

            // 8. Backup (only if no backup exists yet)
            Path backupFile = sessionFile.resolveSibling(sessionFile.getFileName() + ".bak-compact");
            if (!Files.exists(backupFile)) {
                Files.copy(sessionFile, backupFile, StandardCopyOption.COPY_ATTRIBUTES);
                LOG.info("[SessionCompactor] Backup created: " + backupFile.getFileName());
            }

            // 9. Write compacted file
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

    /**
     * Extract all tool_use ids from an assistant message.
     * Structure: {"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_..."}]}}
     */
    private static Set<String> extractToolUseIds(String jsonLine) {
        Set<String> ids = new HashSet<>();
        try {
            JsonElement el = GSON.fromJson(jsonLine, JsonElement.class);
            if (el == null || !el.isJsonObject()) return ids;

            JsonObject root = el.getAsJsonObject();
            if (!root.has("message")) return ids;

            JsonObject message = root.getAsJsonObject("message");
            if (message == null || !message.has("content")) return ids;

            JsonElement contentEl = message.get("content");
            if (!contentEl.isJsonArray()) return ids;

            JsonArray content = contentEl.getAsJsonArray();
            for (JsonElement item : content) {
                if (!item.isJsonObject()) continue;
                JsonObject itemObj = item.getAsJsonObject();
                if (itemObj.has("type") && "tool_use".equals(itemObj.get("type").getAsString())) {
                    if (itemObj.has("id")) {
                        ids.add(itemObj.get("id").getAsString());
                    }
                }
            }
        } catch (Exception e) {
            // Ignore parsing errors
        }
        return ids;
    }

    /**
     * Extract all tool_result tool_use_ids from a user message.
     * Structure: {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_..."}]}}
     */
    private static Set<String> extractToolResultIds(String jsonLine) {
        Set<String> ids = new HashSet<>();
        try {
            JsonElement el = GSON.fromJson(jsonLine, JsonElement.class);
            if (el == null || !el.isJsonObject()) return ids;

            JsonObject root = el.getAsJsonObject();
            if (!root.has("message")) return ids;

            JsonObject message = root.getAsJsonObject("message");
            if (message == null || !message.has("content")) return ids;

            JsonElement contentEl = message.get("content");
            if (!contentEl.isJsonArray()) return ids;

            JsonArray content = contentEl.getAsJsonArray();
            for (JsonElement item : content) {
                if (!item.isJsonObject()) continue;
                JsonObject itemObj = item.getAsJsonObject();
                if (itemObj.has("type") && "tool_result".equals(itemObj.get("type").getAsString())) {
                    if (itemObj.has("tool_use_id")) {
                        ids.add(itemObj.get("tool_use_id").getAsString());
                    }
                }
            }
        } catch (Exception e) {
            // Ignore parsing errors
        }
        return ids;
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

package com.github.claudecodegui.storage;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Missing rollout histories are an explicit destructive action, separate from lossless VACUUM. */
final class CodexStorageOrphans {
    record Analysis(List<String> ids, String token, JsonObject summary) { }

    static Analysis analyze(CodexStoragePaths paths, String databaseId) throws IOException, SQLException {
        var inventory = new CodexStorageInventory(paths).snapshot();
        if (!inventory.errors().isEmpty()) {
            throw new IOException("INVENTORY_INCOMPLETE");
        }
        Map<String, long[]> totals = new LinkedHashMap<>();
        try (Connection connection = CodexStorageDatabase.open(paths.existingFile(paths.root().resolve(CodexStoragePaths.HISTORY_DATABASE)), true)) {
            CodexStorageDatabase.requireSupported(connection, CodexStoragePaths.HISTORY_DATABASE);
            for (String table : List.of("thread_items", "thread_turns", "thread_realtime_items", "thread_history_projection_state")) {
                String bytes = table.equals("thread_items") || table.equals("thread_realtime_items")
                        ? "COALESCE(SUM(length(CAST(item_json AS BLOB))),0)" : "0";
                try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery(
                        "SELECT thread_id,COUNT(*)," + bytes + " FROM " + table + " GROUP BY thread_id ORDER BY thread_id")) {
                    while (rows.next()) {
                        String id = rows.getString(1);
                        CodexStoragePaths.requireSessionId(id);
                        long[] total = totals.computeIfAbsent(id, ignored -> new long[2]);
                        total[0] += rows.getLong(2);
                        total[1] += rows.getLong(3);
                    }
                }
            }
        }
        List<String> selected = new ArrayList<>();
        int skippedBusy = 0;
        int skippedExisting = 0;
        long rowCount = 0;
        long estimated = 0;
        JsonArray candidates = new JsonArray();
        var digest = CodexStorageDatabase.digest();
        digest.update((paths.identity() + "\n" + databaseId + "\n").getBytes(StandardCharsets.UTF_8));
        for (String id : totals.keySet().stream().sorted().toList()) {
            var entry = inventory.sessions().get(id);
            if (entry == null) {
                throw new IOException("INVENTORY_INCOMPLETE");
            }
            if (!entry.files.isEmpty()) {
                continue;
            }
            if (declaredRolloutExists(entry)) {
                skippedExisting++;
                continue;
            }
            if (entry.running || "SESSION_WRITER_BUSY".equals(entry.deletionUnavailableReason)) {
                skippedBusy++;
                continue;
            }
            long[] count = totals.get(id);
            selected.add(id);
            rowCount += count[0];
            estimated += count[1];
            digest.update((id + ":" + count[0] + ":" + count[1] + "\n").getBytes(StandardCharsets.UTF_8));
            if (candidates.size() < 20) {
                JsonObject candidate = new JsonObject();
                candidate.addProperty("sessionId", id);
                candidate.addProperty("title", entry.title);
                candidate.addProperty("estimatedBytes", count[1]);
                candidates.add(candidate);
            }
        }
        JsonObject result = new JsonObject();
        String token = HexFormat.of().formatHex(digest.digest());
        result.addProperty("databaseId", databaseId);
        result.addProperty("previewToken", token);
        result.addProperty("candidateCount", selected.size());
        result.addProperty("rowCount", rowCount);
        result.addProperty("estimatedBytes", estimated);
        result.addProperty("retainedFileSessions", inventory.sessions().values().stream().filter(entry -> !entry.files.isEmpty()).count());
        result.addProperty("skippedBusyCount", skippedBusy);
        result.addProperty("skippedExistingCount", skippedExisting);
        result.add("candidates", candidates);
        paths.revalidate();
        return new Analysis(List.copyOf(selected), token, result);
    }

    static boolean declaredRolloutExists(CodexStorageInventory.Entry entry) throws IOException {
        if (entry.declaredRollout == null || entry.declaredRollout.isBlank()) {
            return false;
        }
        try {
            Path declared = CodexStoragePaths.declaredRolloutPath(entry.declaredRollout);
            Files.readAttributes(declared, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            return true;
        } catch (NoSuchFileException ignored) {
            return false;
        } catch (RuntimeException error) {
            throw new IOException("INVENTORY_INCOMPLETE", error);
        }
    }

    private CodexStorageOrphans() { }
}

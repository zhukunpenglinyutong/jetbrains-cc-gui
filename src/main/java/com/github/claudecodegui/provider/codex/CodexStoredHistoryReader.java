package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.storage.CodexStorageDatabase;
import com.github.claudecodegui.storage.CodexStoragePaths;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

/** Reads database-only session metadata; transcript paging remains owned by the native CLI. */
final class CodexStoredHistoryReader {
    private final Path home;

    CodexStoredHistoryReader(Path home) {
        this.home = home;
    }

    private boolean available() {
        return home != null && Files.isRegularFile(home.resolve(CodexStoragePaths.HISTORY_DATABASE), LinkOption.NOFOLLOW_LINKS);
    }

    List<CodexHistoryReader.SessionInfo> sessions() throws IOException {
        if (!available() || !Files.isRegularFile(home.resolve("state_5.sqlite"), LinkOption.NOFOLLOW_LINKS)) {
            return List.of();
        }
        CodexStoragePaths paths = new CodexStoragePaths(home);
        List<CodexHistoryReader.SessionInfo> sessions = new ArrayList<>();
        try (Connection connection = open(paths, "state_5.sqlite")) {
            var columns = CodexStorageDatabase.columns(connection, "threads");
            if (!columns.containsAll(List.of("id", "title", "cwd", "created_at", "updated_at", "history_mode"))) {
                return List.of();
            }
            String source = columns.contains("source") ? "source" : "NULL";
            String active = columns.contains("archived") ? " AND archived=0" : "";
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT id,title,cwd,created_at,updated_at," + source + " FROM threads WHERE history_mode='paginated'" + active);
                 ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    if (internalSource(rows.getString(6))) {
                        continue;
                    }
                    CodexHistoryReader.SessionInfo session = new CodexHistoryReader.SessionInfo();
                    session.sessionId = rows.getString(1);
                    session.title = rows.getString(2);
                    session.cwd = rows.getString(3);
                    // Counting native items requires transcript projection; zero would incorrectly mean an empty session.
                    session.messageCount = -1;
                    session.firstTimestamp = rows.getLong(4) * 1000;
                    session.lastTimestamp = rows.getLong(5) * 1000;
                    sessions.add(session);
                }
            }
        } catch (SQLException error) {
            throw new IOException("Codex stored session metadata could not be read", error);
        }
        paths.revalidate();
        return sessions;
    }

    private static Connection open(CodexStoragePaths paths, String name) throws IOException, SQLException {
        return CodexStorageDatabase.open(paths.existingFile(paths.root().resolve(name)), true);
    }

    private static boolean internalSource(String source) {
        if (source == null) {
            return false;
        }
        try {
            JsonElement value = JsonParser.parseString(source);
            JsonObject metadata = new JsonObject();
            metadata.add("source", value);
            if (value.isJsonPrimitive()) {
                metadata.addProperty("thread_source", value.getAsString());
            }
            return CodexSessionMetadata.isSubagent(metadata);
        } catch (RuntimeException ignored) {
            // An unknown source is insufficient evidence to hide a user session.
            return false;
        }
    }
}

package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.storage.CodexStoragePaths;
import com.google.gson.Gson;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.util.UUID;

import static org.junit.Assert.*;

public class CodexStoredHistoryReaderTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private Path home;
    private String threadId;
    private CodexStoredHistoryReader reader;

    @Before public void setUp() throws Exception {
        SessionIndexCache.getInstance().clearAllCodexCache();
        home = temporary.newFolder("native history with spaces").toPath();
        threadId = UUID.randomUUID().toString();
        reader = new CodexStoredHistoryReader(home);
        Files.createDirectory(home.resolve("sessions"));
        try (Connection state = database("state_5.sqlite"); var sql = state.createStatement()) {
            sql.execute("PRAGMA journal_mode=WAL");
            sql.execute("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,history_mode TEXT)");
            try (var insert = state.prepareStatement("INSERT INTO threads VALUES(?,?,?,?,?,?)")) {
                insert.setString(1, threadId);
                insert.setString(2, "Stored session title");
                insert.setString(3, home.toString());
                insert.setLong(4, 123);
                insert.setLong(5, 456);
                insert.setString(6, "paginated");
                insert.executeUpdate();
            }
        }
        try (Connection history = database(CodexStoragePaths.HISTORY_DATABASE); var sql = history.createStatement()) {
            sql.execute("CREATE TABLE thread_turns(thread_id TEXT)");
        }
    }

    @After public void clearMemoryIndex() {
        SessionIndexCache.getInstance().clearAllCodexCache();
    }

    @Test public void listsDatabaseOnlySessionsWithoutAJsonlRollout() throws Exception {
        var sessions = historyReader().readAllSessions();
        assertEquals(1, sessions.size());
        assertEquals(threadId, sessions.get(0).sessionId);
        assertEquals("Stored session title", sessions.get(0).title);
        assertEquals(-1, sessions.get(0).messageCount);
        assertEquals(456_000, sessions.get(0).lastTimestamp);
        assertFalse(Files.exists(home.resolve("sessions/rollout-" + threadId + ".jsonl")));
        var all = JsonParser.parseString(historyReader().getAllSessionsAsJson()).getAsJsonObject();
        var project = JsonParser.parseString(historyReader().getSessionsForProjectAsJson(home.toString())).getAsJsonObject();
        assertFalse("Unknown message counts must not produce a negative aggregate", all.has("total"));
        assertFalse(project.has("total"));
        assertEquals(1, all.get("sessionCount").getAsInt());
        assertEquals(1, project.get("sessionCount").getAsInt());
    }

    @Test public void readsCommittedWalMetadataWithoutCheckpointingTheWriter() throws Exception {
        try (Connection writer = database("state_5.sqlite"); var sql = writer.createStatement()) {
            sql.execute("PRAGMA wal_autocheckpoint=0");
            try (var update = writer.prepareStatement("UPDATE threads SET title=? WHERE id=?")) {
                update.setString(1, "Committed WAL title");
                update.setString(2, threadId);
                update.executeUpdate();
            }
            assertEquals("Committed WAL title", reader.sessions().get(0).title);
            writer.setAutoCommit(false);
            sql.execute("UPDATE threads SET title='Uncommitted title'");
            assertEquals("Committed WAL title", reader.sessions().get(0).title);
            writer.rollback();
        }
    }

    @Test public void omitsArchivedAndInternalThreads() throws Exception {
        try (Connection connection = database("state_5.sqlite"); var sql = connection.createStatement()) {
            sql.execute("ALTER TABLE threads ADD COLUMN source TEXT");
            sql.execute("ALTER TABLE threads ADD COLUMN archived INTEGER DEFAULT 0");
            for (String source : java.util.List.of("{\"subagent\":{}}", "{\"internal\":\"guardian\"}", "guardian_review")) {
                try (var update = connection.prepareStatement("UPDATE threads SET source=?")) {
                    update.setString(1, source);
                    update.executeUpdate();
                }
                assertTrue(reader.sessions().isEmpty());
            }
            sql.execute("UPDATE threads SET source='exec',archived=1");
            assertTrue(reader.sessions().isEmpty());
            sql.execute("UPDATE threads SET archived=0");
            assertEquals(1, reader.sessions().size());
        }
    }

    @Test public void toleratesOlderMetadataSchemasAndMissingDatabases() throws Exception {
        try (Connection connection = database("state_5.sqlite"); var sql = connection.createStatement()) {
            sql.execute("ALTER TABLE threads DROP COLUMN history_mode");
        }
        assertTrue(reader.sessions().isEmpty());
        Path empty = temporary.newFolder("no database").toPath();
        assertTrue(new CodexStoredHistoryReader(empty).sessions().isEmpty());
        assertFalse(Files.exists(empty.resolve("state_5.sqlite")));
    }

    @Test public void mergesFileAndDatabaseMetadataWithoutDuplicatingAThread() throws Exception {
        Path rollout = home.resolve("sessions/rollout-2026-10-20T01-00-00-" + threadId + ".jsonl");
        Files.writeString(rollout, """
                {"type":"session_meta","timestamp":"2026-10-20T01:00:00Z","payload":{"id":"%s","cwd":"/fixture"}}
                {"type":"event_msg","timestamp":"2026-10-20T01:00:01Z","payload":{"type":"user_message","message":"File session title"}}
                {"type":"response_item","timestamp":"2026-10-20T01:00:02Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Fixture response"}]}}
                """.formatted(threadId));
        var lite = new CodexSessionLiteReader().readSessionLite(rollout);
        assertNotNull("The JSONL fixture must be eligible for the file index", lite);
        assertEquals(1, lite.messageCount);
        var sessions = historyReader().readAllSessions();
        assertEquals(1, sessions.size());
        assertEquals(threadId, sessions.get(0).sessionId);
        assertEquals(Files.size(rollout), sessions.get(0).fileSize);
    }

    private CodexHistoryReader historyReader() {
        return new CodexHistoryReader(home.resolve("sessions"), new Gson(), new SessionIndexManager(home.resolve("cache")));
    }

    private Connection database(String name) throws Exception {
        return new org.sqlite.JDBC().connect("jdbc:sqlite:" + home.resolve(name), new java.util.Properties());
    }
}

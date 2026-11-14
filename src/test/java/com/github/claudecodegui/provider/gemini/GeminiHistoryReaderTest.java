package com.github.claudecodegui.provider.gemini;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.FileTime;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Acceptance tests for the Gemini history round-trip (Story 1.7, spec CAP-9).
 *
 * <p>Mirrors the {@code OpenCodeHistoryReaderTest} fixture conventions: a temp
 * CLI home is injected through the package-private test constructor, fixture
 * SQLite conversation databases are built with sqlite-jdbc, and the shared
 * listing JSON envelope ({@code success/sessions/sessionCount/total}) is the
 * contract the HistoryView consumes.
 *
 * <p><b>Fixture wire map (story Task 0 acceptance floor).</b> The flat map below is
 * the decode-pipeline contract: field 1 {@code user_input}, field 2
 * {@code agent_response}, field 3 {@code tool_name}, field 4 {@code tool_summary},
 * encoded with the standard protobuf wire format (tag = {@code field << 3 | 2},
 * varint length, UTF-8 bytes) and {@code step_type} discriminators
 * {@code user}/{@code agent}/{@code tool}.
 *
 * <p><b>Conscious re-pin after the live-DB spike (agy 1.1.22, 2026-09-04):</b> real
 * storage differs — {@code step_type} is an INTEGER enum (14 user / 15 agent /
 * 132 tool; 101+ are CLI bookkeeping) and the payload nests content one level down
 * (user text under field 19.2, agent reply under 20.1 with 20.3 as the legacy
 * fallback, tool calls under 20.7, executed
 * call under 5.4, render/result under 140). The reader honours BOTH shapes; the
 * live shape is pinned by {@link #liveIntegerStepTypesAndNestedEnvelopesDecode()}.
 * The contract under test remains the decode pipeline (envelope shape, ordering,
 * honesty), not the concrete field numbers.
 */
public class GeminiHistoryReaderTest {

    private static final String PROJECT = "/Users/dev/ccg17-proj";
    private static final String PROJECT_URI = "file://" + PROJECT;
    private static final String OTHER_PROJECT_URI = "file:///Users/dev/other-proj";

    private static final String UUID_A = "11111111-1111-4111-8111-111111111111";
    private static final String UUID_B = "22222222-2222-4222-8222-222222222222";
    private static final String UUID_C = "33333333-3333-4333-8333-333333333333";
    private static final String UUID_D = "44444444-4444-4444-8444-444444444444";

    private static final String T_OLD = "2026-04-16T10:14:21.956Z";
    private static final String T_NEW = "2026-05-20T04:31:59.990Z";

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    // ------------------------------------------------------------------
    // AC1 — listing through the shared history mechanism
    // ------------------------------------------------------------------

    @Test
    public void listsProjectSessionsFromMetadataCacheThroughTheSharedEnvelope() throws Exception {
        Path home = cliHome();
        writeCache(home, cacheWith(
                sessionEntry(UUID_A, "Fix login bug", "the login is broken", 4, T_NEW, PROJECT_URI),
                sessionEntry(UUID_B, "Other project chat", "unrelated", 2, T_OLD, OTHER_PROJECT_URI)));
        createConversationDb(home, UUID_A, userStep("hello"), agentStep("hi"));
        createConversationDb(home, UUID_B, userStep("elsewhere"));
        // Database last written before the cache entry, so the cache time is the newest.
        Files.setLastModifiedTime(home.resolve("conversations").resolve(UUID_A + ".db"),
                FileTime.from(Instant.parse(T_OLD)));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        JsonObject envelope = parse(reader.getSessionsForProjectAsJson(PROJECT));

        assertTrue(envelope.get("success").getAsBoolean());
        assertEquals(1, envelope.get("sessionCount").getAsInt());
        JsonArray sessions = envelope.getAsJsonArray("sessions");
        assertEquals(1, sessions.size());

        JsonObject session = sessions.get(0).getAsJsonObject();
        assertEquals(UUID_A, session.get("sessionId").getAsString());
        assertEquals("Fix login bug", session.get("title").getAsString());
        assertEquals(4, session.get("messageCount").getAsInt());
        assertEquals("gemini", session.get("provider").getAsString());
        assertEquals(Instant.parse(T_NEW).toEpochMilli(), session.get("lastTimestamp").getAsLong());
        assertEquals(PROJECT, session.get("cwd").getAsString());
    }

    @Test
    public void titlePriorityIsTitleThenPreviewThenId() throws Exception {
        Path home = cliHome();
        // M1: a cache entry is only listed when its conversation database exists —
        // every listed fixture entry gets one.
        createConversationDb(home, UUID_A, userStep("a"));
        createConversationDb(home, UUID_B, userStep("b"));
        createConversationDb(home, UUID_C, userStep("c"));
        writeCache(home, cacheWith(
                sessionEntry(UUID_A, "Real Title", "preview ignored", 1, T_NEW, PROJECT_URI),
                sessionEntry(UUID_B, "", "first prompt wins", 1, T_OLD, PROJECT_URI),
                sessionEntry(UUID_C, "", "", 1, T_OLD, PROJECT_URI)));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        JsonArray sessions =
                parse(reader.getSessionsForProjectAsJson(PROJECT)).getAsJsonArray("sessions");
        assertEquals(3, sessions.size());

        JsonObject byId = bySessionId(sessions, UUID_A);
        JsonObject byPreview = bySessionId(sessions, UUID_B);
        JsonObject byUuid = bySessionId(sessions, UUID_C);
        assertEquals("Real Title", byId.get("title").getAsString());
        assertEquals("first prompt wins", byPreview.get("title").getAsString());
        assertEquals(UUID_C, byUuid.get("title").getAsString());
    }

    @Test
    public void lastConversationsCwdEntryCountsAsProjectMatch() throws Exception {
        Path home = cliHome();
        // UUID_A points its workspace elsewhere, but is the CLI's latest
        // conversation for the current project directory.
        createConversationDb(home, UUID_A, userStep("latest"));
        createConversationDb(home, UUID_B, userStep("never"));
        writeCache(home, cacheWith(
                sessionEntry(UUID_A, "Latest here", "preview", 2, T_NEW, OTHER_PROJECT_URI),
                sessionEntry(UUID_B, "Never here", "preview", 1, T_OLD, OTHER_PROJECT_URI)));
        writeLastConversations(home, "{ \"" + PROJECT + "\": \"" + UUID_A + "\" }");

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        JsonArray sessions =
                parse(reader.getSessionsForProjectAsJson(PROJECT)).getAsJsonArray("sessions");
        assertEquals(1, sessions.size());
        assertEquals(UUID_A, sessions.get(0).getAsJsonObject().get("sessionId").getAsString());
    }

    @Test
    public void entriesWithoutResolvableWorkspaceAreSkippedForProjectScoping() throws Exception {
        Path home = cliHome();
        createConversationDb(home, UUID_A, userStep("has workspace"));
        createConversationDb(home, UUID_D, userStep("no workspace"));
        writeCache(home, cacheWith(
                sessionEntry(UUID_A, "Has workspace", "preview", 1, T_NEW, PROJECT_URI),
                sessionEntry(UUID_D, "No workspace", "preview", 1, T_OLD)));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        JsonArray sessions =
                parse(reader.getSessionsForProjectAsJson(PROJECT)).getAsJsonArray("sessions");
        assertEquals(1, sessions.size());
        assertEquals(UUID_A, sessions.get(0).getAsJsonObject().get("sessionId").getAsString());
    }

    @Test
    public void malformedCacheEntriesAreSkippedWithoutThrowing() throws Exception {
        Path home = cliHome();
        // UUID_E has a summary object missing every field; UUID_F's summary is
        // a bare string instead of an object. Both must be skipped; UUID_A must
        // survive; the reader must not throw.
        createConversationDb(home, UUID_A, userStep("healthy"));
        String json = "{ \"conversations\": {"
                + sessionEntry(UUID_A, "Healthy", "preview", 1, T_NEW, PROJECT_URI) + ", "
                + "\"eeeeeeee-3333-4333-8333-333333333333\": { \"summary\": {} }, "
                + "\"ffffffff-3333-4333-8333-333333333333\": { \"summary\": \"not-an-object\" }"
                + " } }";
        writeCache(home, json);

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        JsonObject envelope = parse(reader.getSessionsForProjectAsJson(PROJECT));
        assertTrue(envelope.get("success").getAsBoolean());
        assertEquals(1, envelope.get("sessionCount").getAsInt());
        assertEquals(UUID_A,
                envelope.getAsJsonArray("sessions").get(0).getAsJsonObject()
                        .get("sessionId").getAsString());
    }

    @Test
    public void missingCacheFileFallsBackToScanningConversationDatabases() throws Exception {
        Path home = cliHome();
        // No cache/conversation_metadata.json at all — the reader must still
        // discover the conversation databases. With no summaries database the
        // title is the first user prompt, and the reader must not throw.
        createConversationDb(home, UUID_A, userStep("hello"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        JsonObject envelope = parse(reader.getSessionsForProjectAsJson(null));
        assertTrue(envelope.get("success").getAsBoolean());
        assertTrue(envelope.get("sessionCount").getAsInt() >= 1);
        JsonArray sessions = envelope.getAsJsonArray("sessions");
        boolean found = false;
        for (JsonElement element : sessions) {
            if (UUID_A.equals(element.getAsJsonObject().get("sessionId").getAsString())) {
                found = true;
                assertEquals("hello", element.getAsJsonObject().get("title").getAsString());
            }
        }
        assertTrue(found);
    }

    @Test
    public void cacheEntryWithoutConversationDatabaseIsSkipped() throws Exception {
        Path home = cliHome();
        // The CLI can leave cache entries behind after a storage reset (live
        // 2026-09-04: 84 entries, none with a database on disk). Only entries
        // whose conversations/<id>.db still exists are listed.
        writeCache(home, cacheWith(
                sessionEntry(UUID_A, "Ghost", "no db on disk", 3, T_NEW, PROJECT_URI),
                sessionEntry(UUID_B, "Real", "backed by its db", 1, T_OLD, PROJECT_URI)));
        createConversationDb(home, UUID_B, userStep("real"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        JsonArray sessions =
                parse(reader.getSessionsForProjectAsJson(PROJECT)).getAsJsonArray("sessions");
        assertEquals(1, sessions.size());
        assertEquals(UUID_B, sessions.get(0).getAsJsonObject().get("sessionId").getAsString());
    }

    @Test
    public void staleCacheWithOnlyGhostEntriesFallsBackToDatabaseScan() throws Exception {
        Path home = cliHome();
        // Live shape of the M1 finding: every cache entry is a ghost, and the real
        // conversations exist only as databases. The scan must take over and the
        // ghosts must not shadow the real sessions.
        writeCache(home, cacheWith(
                sessionEntry(UUID_A, "Ghost", "db gone", 3, T_NEW, PROJECT_URI)));
        createConversationDb(home, UUID_B, userStep("real one"));
        createConversationDb(home, UUID_C, userStep("real two"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        JsonObject envelope = parse(reader.getSessionsForProjectAsJson(null));
        assertTrue(envelope.get("success").getAsBoolean());
        assertEquals(2, envelope.get("sessionCount").getAsInt());
        JsonArray sessions = envelope.getAsJsonArray("sessions");
        // The real sessions surface through the scan (mtime-ordered); the ghost
        // is nowhere in the listing.
        java.util.Set<String> ids = new java.util.TreeSet<>();
        for (JsonElement element : sessions) {
            ids.add(element.getAsJsonObject().get("sessionId").getAsString());
        }
        assertEquals(new java.util.TreeSet<>(java.util.List.of(UUID_B, UUID_C)), ids);
    }

    @Test
    public void databaseScanScopesSessionsByWorkspaceStoredInTheDatabase() throws Exception {
        Path home = cliHome();
        // The metadata cache is a dead generation. Each live database carries its
        // workspace in trajectory_metadata_blob, so project scoping must not
        // collapse to the single id in last_conversations.json.
        writeCache(home, cacheWith(
                sessionEntry(UUID_D, "Ghost", "db gone", 1, T_NEW, PROJECT_URI)));
        createConversationDb(home, UUID_A, userStep("in this project"));
        createConversationDb(home, UUID_B, userStep("in the other project"));
        writeTrajectoryWorkspace(home, UUID_A, PROJECT_URI);
        writeTrajectoryWorkspace(home, UUID_B, OTHER_PROJECT_URI);
        writeLastConversations(home, "{ \"" + PROJECT + "\": \"" + UUID_D + "\" }");

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        JsonArray sessions =
                parse(reader.getSessionsForProjectAsJson(PROJECT)).getAsJsonArray("sessions");
        assertEquals(1, sessions.size());
        JsonObject session = sessions.get(0).getAsJsonObject();
        assertEquals(UUID_A, session.get("sessionId").getAsString());
        assertEquals("in this project", session.get("title").getAsString());
        assertEquals(PROJECT, session.get("cwd").getAsString());
    }

    @Test
    public void cacheEntryWithExistingDatabaseIsStillListedFromCache() throws Exception {
        Path home = cliHome();
        // Legacy path preserved: a backed entry keeps its cache metadata
        // (title/step count) instead of degrading to the id-as-title scan.
        writeCache(home, cacheWith(
                sessionEntry(UUID_A, "Cache Title", "preview", 5, T_NEW, PROJECT_URI)));
        createConversationDb(home, UUID_A, userStep("hello"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        JsonArray sessions =
                parse(reader.getSessionsForProjectAsJson(PROJECT)).getAsJsonArray("sessions");
        assertEquals(1, sessions.size());
        JsonObject session = sessions.get(0).getAsJsonObject();
        assertEquals(UUID_A, session.get("sessionId").getAsString());
        assertEquals("Cache Title", session.get("title").getAsString());
        assertEquals(5, session.get("messageCount").getAsInt());
    }

    // ------------------------------------------------------------------
    // STORY-002 — Scan databases and merge with metadata cache
    // ------------------------------------------------------------------

    @Test
    public void listAllSessionsMergesCacheWithNewerUncachedDatabases() throws Exception {
        Path home = cliHome();
        // UUID_A is in metadata cache with cached title, preview, and messageCount=5
        writeCache(home, cacheWith(
                sessionEntry(UUID_A, "Cached Session A", "preview A", 5, T_OLD, PROJECT_URI)));
        createConversationDb(home, UUID_A, userStep("cached db prompt"));
        Files.setLastModifiedTime(home.resolve("conversations").resolve(UUID_A + ".db"),
                FileTime.from(Instant.parse(T_OLD)));

        // UUID_B exists only as a database on disk (not in metadata cache) with a newer mtime
        createConversationDb(home, UUID_B, userStep("Uncached session B prompt"));
        Path dbB = home.resolve("conversations").resolve(UUID_B + ".db");
        Files.setLastModifiedTime(dbB, FileTime.from(Instant.parse(T_NEW)));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<GeminiHistoryReader.SessionInfo> sessions = reader.listAllSessions();

        // Must return both sessions (cached + discovered from db scan)
        assertEquals(2, sessions.size());

        // Sorted by lastTimestamp descending: UUID_B (T_NEW) before UUID_A (T_OLD)
        GeminiHistoryReader.SessionInfo sessionB = sessions.get(0);
        assertEquals(UUID_B, sessionB.sessionId);
        assertEquals("Uncached session B prompt", sessionB.title);

        GeminiHistoryReader.SessionInfo sessionA = sessions.get(1);
        assertEquals(UUID_A, sessionA.sessionId);
        assertEquals("Cached Session A", sessionA.title);
        assertEquals(5, sessionA.messageCount);
    }

    @Test
    public void listAllSessionsPrefersNewerDatabaseTimeOverStaleCacheEntry() throws Exception {
        Path home = cliHome();
        // A was cached long ago, but its database was written after B's.
        writeCache(home, cacheWith(
                sessionEntry(UUID_A, "Cached Session A", "preview A", 5, T_OLD, PROJECT_URI)));
        createConversationDb(home, UUID_A, userStep("still active"));
        createConversationDb(home, UUID_B, userStep("other session"));
        Path conversations = home.resolve("conversations");
        Files.setLastModifiedTime(conversations.resolve(UUID_B + ".db"), FileTime.from(Instant.parse(T_NEW)));
        Instant activeToday = Instant.parse(T_NEW).plusSeconds(3600);
        Files.setLastModifiedTime(conversations.resolve(UUID_A + ".db"), FileTime.from(activeToday));

        List<GeminiHistoryReader.SessionInfo> sessions = new GeminiHistoryReader(home, new Gson()).listAllSessions();

        assertEquals(UUID_A, sessions.get(0).sessionId);
        assertEquals(activeToday.toEpochMilli(), sessions.get(0).lastTimestamp);
        assertEquals("Cached Session A", sessions.get(0).title);
    }

    @Test
    public void matchesProjectOnWindowsFileUriWithLeadingSlash() throws Exception {
        Path home = cliHome();
        String winWorkspaceUri = "file:///C:/Users/me/proj";
        String winProjectPath = "C:\\Users\\me\\proj";

        // Session carrying a Windows file URI with leading slash /C:/...
        writeCache(home, cacheWith(
                sessionEntry(UUID_A, "Windows Session", "preview", 3, T_NEW, winWorkspaceUri)));
        createConversationDb(home, UUID_A, userStep("hello windows"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<GeminiHistoryReader.SessionInfo> sessions = reader.listSessionsForProject(winProjectPath);

        assertEquals(1, sessions.size());
        GeminiHistoryReader.SessionInfo session = sessions.get(0);
        assertEquals(UUID_A, session.sessionId);
        assertEquals("C:/Users/me/proj", session.cwd);

        // Also verify JSON envelope output
        JsonObject envelope = parse(reader.getSessionsForProjectAsJson(winProjectPath));
        assertEquals(1, envelope.get("sessionCount").getAsInt());
        JsonObject jsonSession = envelope.getAsJsonArray("sessions").get(0).getAsJsonObject();
        assertEquals(UUID_A, jsonSession.get("sessionId").getAsString());
        assertEquals("C:/Users/me/proj", jsonSession.get("cwd").getAsString());
    }

    @Test
    public void scanPopulatesMessageCountFiltersSubagentsAndCachesByMtime() throws Exception {
        Path home = cliHome();

        // 1. Parent session UUID_A with step 101 referencing subagent child UUID_B
        createConversationDb(home, UUID_A,
                new Step(0, "user", protoField(1, "Main parent prompt")),
                new Step(1, "agent", protoField(2, "Delegating to subagent")),
                new Step(2, "101", ("[Message] timestamp=2026-11-01T12:00:00Z sender="
                        + UUID_B + " priority=HIGH content=Done").getBytes(StandardCharsets.UTF_8)));

        // 2. Child subagent session UUID_B
        createConversationDb(home, UUID_B,
                new Step(0, "user", protoField(1, "Subagent task prompt")),
                new Step(1, "agent", protoField(2, "Subagent task reply")));

        // 3. Normal session UUID_C with 2 user/agent steps
        createConversationDb(home, UUID_C,
                new Step(0, "user", protoField(1, "Normal query")),
                new Step(1, "agent", protoField(2, "Normal reply")));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<GeminiHistoryReader.SessionInfo> sessions = reader.listAllSessions();

        // Subagent child UUID_B must be excluded from top-level session history
        assertFalse("Subagent child DB must not be listed in session history",
                sessions.stream().anyMatch(s -> UUID_B.equals(s.sessionId)));

        // UUID_A and UUID_C must be listed
        assertTrue("Parent session must be listed",
                sessions.stream().anyMatch(s -> UUID_A.equals(s.sessionId)));

        GeminiHistoryReader.SessionInfo sessionC = sessions.stream()
                .filter(s -> UUID_C.equals(s.sessionId))
                .findFirst()
                .orElseThrow(() -> new AssertionError("Session C not found"));

        // Message count must be populated from user/agent step count (not 0)
        assertEquals(2, sessionC.messageCount);
        assertEquals("Normal query", sessionC.title);

        // 4. Verify ScanMeta caching by (path, mtime):
        Path dbC = home.resolve("conversations").resolve(UUID_C + ".db");
        long mtimeC = Files.getLastModifiedTime(dbC).toMillis();

        // Alter database contents on disk without updating mtime
        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + dbC.toAbsolutePath());
             Statement stmt = conn.createStatement()) {
            stmt.execute("UPDATE steps SET step_payload = X'' WHERE idx = 0");
        }
        Files.setLastModifiedTime(dbC, FileTime.fromMillis(mtimeC));

        // Re-read: should return cached ScanMeta because mtime was unchanged
        List<GeminiHistoryReader.SessionInfo> cachedRun = reader.listAllSessions();
        GeminiHistoryReader.SessionInfo sessionCAfter = cachedRun.stream()
                .filter(s -> UUID_C.equals(s.sessionId))
                .findFirst()
                .orElseThrow(() -> new AssertionError("Session C not found in cached run"));
        assertEquals("Cached ScanMeta should be reused when mtime is unchanged",
                "Normal query", sessionCAfter.title);
        assertEquals("Cached ScanMeta messageCount should be preserved",
                2, sessionCAfter.messageCount);

        // Bump mtime: cache must be invalidated and DB re-read
        Files.setLastModifiedTime(dbC, FileTime.fromMillis(mtimeC + 5000));
        List<GeminiHistoryReader.SessionInfo> invalidatedRun = reader.listAllSessions();
        GeminiHistoryReader.SessionInfo sessionCInvalidated = invalidatedRun.stream()
                .filter(s -> UUID_C.equals(s.sessionId))
                .findFirst()
                .orElseThrow(() -> new AssertionError("Session C not found in invalidated run"));
        // Since payload was cleared to empty blob, firstUserText is null and title falls back to UUID_C
        assertEquals(UUID_C, sessionCInvalidated.title);
    }

    @Test
    public void scanKeepsParentWhenStep101SenderIsTaskPath() throws Exception {
        Path home = cliHome();
        String taskNotice = """
                [Message] timestamp=2026-11-01T12:00:00Z sender=%s/task-1 priority=HIGH content=Task done"""
                .formatted(UUID_A);
        String childNotice = """
                [Message] timestamp=2026-11-01T12:00:01Z sender=%s priority=HIGH content=Child done"""
                .formatted(UUID_B);
        createConversationDb(home, UUID_A,
                new Step(0, "user", protoField(1, "Parent prompt")),
                new Step(1, "101", taskNotice.getBytes(StandardCharsets.UTF_8)),
                new Step(2, "101", childNotice.getBytes(StandardCharsets.UTF_8)));
        createConversationDb(home, UUID_B,
                new Step(0, "user", protoField(1, "Child prompt")));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<GeminiHistoryReader.SessionInfo> sessions = reader.listAllSessions();

        assertTrue("Parent with sender=<id>/task-N must stay listed",
                sessions.stream().anyMatch(s -> UUID_A.equals(s.sessionId)));
        assertFalse("Referenced child sender must stay excluded",
                sessions.stream().anyMatch(s -> UUID_B.equals(s.sessionId)));
    }

    // ------------------------------------------------------------------
    // AC2 — content loading (and AC3 — the same envelopes feed export)
    // ------------------------------------------------------------------

    @Test
    public void loadRestoresConversationContentAsClaudeCompatibleEnvelopes() throws Exception {
        Path home = cliHome();
        createConversationDb(home, UUID_A,
                userStep("hello gemini"),
                agentStep("hi human"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        assertEquals(2, messages.size());
        JsonObject user = messages.get(0);
        assertEquals("user", user.get("type").getAsString());
        assertEquals("hello gemini", textOf(user));

        JsonObject assistant = messages.get(1);
        assertEquals("assistant", assistant.get("type").getAsString());
        assertEquals("hi human", textOf(assistant));
    }

    @Test
    public void toolStepsBecomeToolUseAndToolResultPairs() throws Exception {
        Path home = cliHome();
        createConversationDb(home, UUID_A,
                userStep("read the file"),
                toolStep("read_file", "read a.txt"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        JsonObject toolUse = findBlock(messages, "tool_use");
        JsonObject toolResult = findBlock(messages, "tool_result");
        assertEquals("read_file", toolUse.get("name").getAsString());
        assertEquals(toolUse.get("id").getAsString(), toolResult.get("tool_use_id").getAsString());
        // Content summaries come from the DB or are not emitted at all — never fabricated.
        assertTrue(toolResult.has("content"));
    }

    @Test
    public void undecodablePayloadsAreSkippedAndNeverFabricated() throws Exception {
        Path home = cliHome();
        createConversationDb(home, UUID_A,
                new Step(0, "user", "not protobuf at all".getBytes(StandardCharsets.UTF_8)),
                agentStep("survives"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        // The undecodable step is skipped (no fabricated placeholder), the
        // decodable one still loads.
        assertEquals(1, messages.size());
        assertEquals("assistant", messages.get(0).get("type").getAsString());

        // A conversation whose every step is undecodable yields honest emptiness.
        createConversationDb(home, UUID_B,
                new Step(0, "user", new byte[] {0x00, 0x01, 0x02}));
        assertTrue(reader.getSessionMessages(UUID_B, PROJECT).isEmpty());
    }

    @Test
    public void sessionIdOutsideSharedWhitelistIsRefused() throws Exception {
        Path home = cliHome();
        createConversationDb(home, UUID_A, userStep("hello"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        // Same ^[A-Za-z0-9._-]+$ whitelist the shared delete service enforces.
        assertTrue(reader.getSessionMessages("../evil", PROJECT).isEmpty());
        assertTrue(reader.getSessionMessages("a/b", PROJECT).isEmpty());
        assertTrue(reader.getSessionMessages("", PROJECT).isEmpty());
    }

    @Test
    public void missingConversationDatabaseYieldsEmptyList() throws Exception {
        Path home = cliHome();
        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        assertTrue(reader.getSessionMessages(UUID_A, PROJECT).isEmpty());
    }

    @Test
    public void failedTempCopyCleansUpItsTempDirectory() throws Exception {
        // L3: a copy that fails after the temp dir exists must remove that dir —
        // nothing leaks into java.io.tmpdir.
        Path home = cliHome();
        Path tmp = Paths.get(System.getProperty("java.io.tmpdir"));
        java.util.Set<String> before = geminiTempDirs(tmp);

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        // Source database does not exist → Files.copy fails after the temp dir
        // was created; the reader removes it instead of leaking it.
        assertNull(reader.copyWithSidecarsToTemp(
                home.resolve("conversations").resolve(UUID_A + ".db")));

        assertEquals(before, geminiTempDirs(tmp));
    }

    @Test
    public void everyEnvelopeCarriesTheSharedExportShape() throws Exception {
        Path home = cliHome();
        createConversationDb(home, UUID_A,
                userStep("ask"),
                agentStep("answer"),
                toolStep("grep", "searched"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);
        assertFalse(messages.isEmpty());
        for (JsonObject message : messages) {
            String type = message.get("type").getAsString();
            assertTrue("user".equals(type) || "assistant".equals(type));
            // The shared export path serializes exactly this list — every
            // envelope must carry message.content for the export envelope
            // {sessionId, title, provider, messages} to be well-formed.
            JsonArray content = message.getAsJsonObject("message").getAsJsonArray("content");
            assertTrue(content.size() >= 1);
        }
    }

    @Test
    public void liveIntegerStepTypesAndNestedEnvelopesDecode() throws Exception {
        // The live-DB spike (agy 1.1.22) pinned a different wire shape than the flat
        // fixture map above: step_type is an integer enum and content sits one nesting
        // level down. This test keeps that live shape pinned so a CLI-side drift is
        // caught here instead of silently emptying real users' history.
        Path home = cliHome();
        createLiveConversationDb(home, UUID_A,
                liveStep(14, protoMessage(19, protoField(2, "live user text"))),
                liveStep(15, protoMessage(20, concat(
                        protoField(3, "live agent text"),
                        protoMessage(7, concat(
                                protoField(1, "call_live"),
                                protoField(2, "run_command"),
                                protoField(3, "{\"DirectoryPath\":\"/tmp\"}")))))),
                liveStep(132, concat(
                        protoMessage(5, protoMessage(4, concat(
                                protoField(1, "call_live"),
                                protoField(2, "run_command"),
                                protoField(3, "{\"DirectoryPath\":\"/tmp\"}")))),
                        protoMessage(140, concat(
                                protoMessage(1, concat(
                                        protoField(1, "toolSummary"),
                                        protoField(2, "List dir"))),
                                protoField(2, "{\"name\":\"hello.txt\"}"))))),
                liveStep(101, protoMessage(114, protoField(1, "[Notice] CLI bookkeeping"))));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        // user text + agent text + one deduplicated tool_use + its tool_result;
        // the type-101 bookkeeping step contributes nothing.
        assertEquals(4, messages.size());
        assertEquals("user", messages.get(0).get("type").getAsString());
        assertEquals("live user text", textOf(messages.get(0)));
        assertEquals("assistant", messages.get(1).get("type").getAsString());
        assertEquals("live agent text", textOf(messages.get(1)));

        int toolUseCount = 0;
        JsonObject toolUse = null;
        JsonObject toolResult = null;
        for (JsonObject message : messages) {
            for (JsonElement element : message.getAsJsonObject("message").getAsJsonArray("content")) {
                JsonObject block = element.getAsJsonObject();
                if ("tool_use".equals(block.get("type").getAsString())) {
                    toolUseCount++;
                    toolUse = block;
                } else if ("tool_result".equals(block.get("type").getAsString())) {
                    toolResult = block;
                }
            }
        }
        assertEquals(1, toolUseCount);
        assertEquals("call_live", toolUse.get("id").getAsString());
        assertEquals("run_command", toolUse.get("name").getAsString());
        assertEquals(toolUse.get("id").getAsString(), toolResult.get("tool_use_id").getAsString());
        assertEquals("{\"name\":\"hello.txt\"}", toolResult.get("content").getAsString());
    }

    @Test
    public void liveAgentReplyInField1IsShownAndField3NarrationIsNotTheAnswer() throws Exception {
        Path home = cliHome();
        createLiveConversationDb(home, UUID_A,
                liveStep(15, protoMessage(20, concat(
                        protoField(1, "the written reply"),
                        protoField(3, "thinking narration that must not replace the reply"),
                        protoField(8, "the written reply")))));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        assertEquals(1, messages.size());
        assertEquals("assistant", messages.get(0).get("type").getAsString());
        assertEquals("the written reply", textOf(messages.get(0)));
        JsonObject thinking = findBlock(messages, "thinking");
        assertEquals("thinking narration that must not replace the reply", thinking.get("thinking").getAsString());
    }

    @Test
    public void field3BesideField11IsAThinkingSummaryNotTheAnswer() throws Exception {
        // Session faa7b6e2: tool steps carry an English narration in field 3 and
        // a field 11 marker, with no field 1. That narration must not become
        // the assistant message. The 2026-09-04 shape has field 3 and no field 11.
        Path home = cliHome();
        createLiveConversationDb(home, UUID_A,
                liveStep(15, protoMessage(20, concat(
                        protoField(3, "Checksum verification confirms data integrity"),
                        protoMessage(11, protoField(2, "marker")),
                        protoMessage(7, concat(
                                protoField(1, "call_flash"),
                                protoField(2, "run_command"),
                                protoField(3, "{}")))))));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        assertEquals(1, messages.size());
        JsonObject toolUse = findBlock(messages, "tool_use");
        assertEquals("run_command", toolUse.get("name").getAsString());
        JsonObject thinking = findBlock(messages, "thinking");
        assertEquals("Checksum verification confirms data integrity", thinking.get("thinking").getAsString());
        for (JsonObject message : messages) {
            if (!"assistant".equals(message.get("type").getAsString())) {
                continue;
            }
            for (JsonElement element : message.getAsJsonObject("message").getAsJsonArray("content")) {
                JsonObject block = element.getAsJsonObject();
                if (block.has("text")) {
                    assertFalse(block.get("text").getAsString().contains("Checksum verification"));
                }
            }
        }
    }

    @Test
    public void everyRepeatedAgentContentBlobContributesTextAndToolCalls() throws Exception {
        // L1: an agent step carrying TWO repeated f20 blobs — the first call-only,
        // the second with text and a call. Committing to one blob (any rule built on
        // "first blob") drops the other's content; iteration keeps both calls and
        // the text. (Live corpus: 22382/22382 agent steps have exactly ONE f20 —
        // the iteration rule replaces the old first-blob assumption.)
        Path home = cliHome();
        createLiveConversationDb(home, UUID_A,
                liveStep(15, concat(
                        protoMessage(20, protoMessage(7, concat(
                                protoField(1, "call_first"),
                                protoField(2, "first_tool"),
                                protoField(3, "{}")))),
                        protoMessage(20, concat(
                                protoField(3, "second blob text"),
                                protoMessage(7, concat(
                                        protoField(1, "call_second"),
                                        protoField(2, "second_tool"),
                                        protoField(3, "{}"))))))));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        // One text envelope (the only text found across the blobs) + both calls.
        assertEquals(3, messages.size());
        assertEquals("assistant", messages.get(0).get("type").getAsString());
        assertEquals("second blob text", textOf(messages.get(0)));
        java.util.Set<String> callIds = new java.util.TreeSet<>();
        for (JsonObject message : messages) {
            for (JsonElement element : message.getAsJsonObject("message").getAsJsonArray("content")) {
                JsonObject block = element.getAsJsonObject();
                if ("tool_use".equals(block.get("type").getAsString())) {
                    callIds.add(block.get("id").getAsString());
                }
            }
        }
        assertEquals(new java.util.TreeSet<>(java.util.List.of("call_first", "call_second")), callIds);
    }

    @Test
    public void nestedToolResultBodyKeepsSubagentConversationIds() throws Exception {
        String ack = "Created the following subagents:\n"
                + "{\n  \"conversationId\": \"6848065b-deb9-4cd6-b3c5-4039020b56e6\"\n}";
        Path home = cliHome();
        byte[] call = concat(
                protoField(1, "call_90027"),
                protoField(2, "invoke_subagent"),
                protoField(3, "{Subagents:[review]}"));
        createLiveConversationDb(home, UUID_A,
                liveStep(15, protoMessage(20, protoMessage(7, call))),
                liveStep(132, concat(
                        protoMessage(5, protoMessage(4, call)),
                        protoMessage(140, concat(
                                protoMessage(1, concat(
                                        protoField(1, "toolSummary"),
                                        protoField(2, "Launch four review subagents"))),
                                protoMessage(2, protoField(1, ack)))))));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        String result = null;
        for (JsonObject message : messages) {
            for (JsonElement element : message.getAsJsonObject("message").getAsJsonArray("content")) {
                JsonObject block = element.getAsJsonObject();
                if ("tool_result".equals(block.get("type").getAsString())) {
                    result = block.get("content").getAsString();
                }
            }
        }
        assertEquals(ack, result);
    }

    @Test
    public void toolResultIsNotEmittedWithoutAToolUseWhenTheCallBlobHasNoName() throws Exception {
        // L2: a call blob without a name emits no tool_use; emitting the paired
        // tool_result anyway would orphan it (null tool_use_id dropped by Gson).
        Path home = cliHome();
        createLiveConversationDb(home, UUID_A,
                liveStep(132, concat(
                        protoMessage(5, protoMessage(4, protoField(1, "call_noname"))),
                        protoMessage(140, concat(
                                protoMessage(1, concat(
                                        protoField(1, "toolSummary"),
                                        protoField(2, "List dir"))),
                                protoField(2, "{\"name\":\"hello.txt\"}"))))));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        assertTrue(messages.isEmpty());
    }

    @Test
    public void unknownStepTypesAreSkippedAndDoNotBreakTheLoad() throws Exception {
        // L5: step types outside the live enum (17/23/90/98/101 — CLI-injected
        // context bookkeeping, 331 steps in the live corpus) are skipped; the
        // summary log line is the contract's "skipped with a log line".
        Path home = cliHome();
        createLiveConversationDb(home, UUID_A,
                liveStep(17, protoMessage(114, protoField(1, "bookkeeping"))),
                liveStep(23, protoMessage(114, protoField(1, "context"))),
                liveStep(90, protoMessage(114, protoField(1, "bookkeeping"))),
                liveStep(98, protoMessage(114, protoField(1, "context"))),
                liveStep(14, protoMessage(19, protoField(2, "still decodes"))));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        assertEquals(1, messages.size());
        assertEquals("still decodes", textOf(messages.get(0)));
    }

    // ------------------------------------------------------------------
    // AC4 — delete semantics
    // ------------------------------------------------------------------

    @Test
    public void deleteRemovesConversationDbWithWalSidecarsAndNothingElse() throws Exception {
        Path home = cliHome();
        createConversationDb(home, UUID_A, userStep("hello"));
        createConversationDb(home, UUID_B, userStep("keep me"));
        Files.writeString(home.resolve("conversations").resolve(UUID_A + ".db-shm"), "shm",
                StandardCharsets.UTF_8);
        Files.writeString(home.resolve("conversations").resolve(UUID_A + ".db-wal"), "wal",
                StandardCharsets.UTF_8);
        Files.writeString(home.resolve("conversations").resolve(UUID_B + ".db-shm"), "shm",
                StandardCharsets.UTF_8);
        Files.writeString(home.resolve("conversations").resolve(UUID_B + ".db-wal"), "wal",
                StandardCharsets.UTF_8);
        Files.writeString(home.resolve("conversations").resolve(UUID_A + ".translated.json"), "{\"ru\":\"a\"}",
                StandardCharsets.UTF_8);
        Files.writeString(home.resolve("conversations").resolve(UUID_A + ".translated.json.bak"), "bak-a",
                StandardCharsets.UTF_8);
        Files.writeString(home.resolve("conversations").resolve(UUID_B + ".translated.json"), "{\"ru\":\"b\"}",
                StandardCharsets.UTF_8);
        Files.writeString(home.resolve("conversations").resolve(UUID_B + ".translated.json.bak"), "bak-b",
                StandardCharsets.UTF_8);
        Path summariesDb = home.resolve("conversation_summaries.db");
        byte[] summariesBytes = "fixed-summaries-bytes".getBytes(StandardCharsets.UTF_8);
        Files.write(summariesDb, summariesBytes);
        Path lastConv = home.resolve("cache").resolve("last_conversations.json");
        byte[] lastConvBytes = "{\"fixed\":\"last-conv\"}".getBytes(StandardCharsets.UTF_8);
        Files.write(lastConv, lastConvBytes);
        writeCache(home, cacheWith(
                sessionEntry(UUID_A, "Doomed", "preview", 1, T_NEW, PROJECT_URI),
                sessionEntry(UUID_B, "Survivor", "preview", 1, T_OLD, PROJECT_URI)));
        byte[] cacheBefore =
                Files.readAllBytes(home.resolve("cache").resolve("conversation_metadata.json"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        assertTrue(reader.deleteSession(UUID_A, PROJECT));

        assertFalse(Files.exists(home.resolve("conversations").resolve(UUID_A + ".db")));
        assertFalse(Files.exists(home.resolve("conversations").resolve(UUID_A + ".db-shm")));
        assertFalse(Files.exists(home.resolve("conversations").resolve(UUID_A + ".db-wal")));
        assertFalse(Files.exists(home.resolve("conversations").resolve(UUID_A + ".translated.json")));
        assertFalse(Files.exists(home.resolve("conversations").resolve(UUID_A + ".translated.json.bak")));
        // Other conversations are untouched — db, sidecars, and caches alike.
        assertTrue(Files.exists(home.resolve("conversations").resolve(UUID_B + ".db")));
        assertTrue(Files.exists(home.resolve("conversations").resolve(UUID_B + ".db-shm")));
        assertTrue(Files.exists(home.resolve("conversations").resolve(UUID_B + ".db-wal")));
        assertTrue(Files.exists(home.resolve("conversations").resolve(UUID_B + ".translated.json")));
        assertTrue(Files.exists(home.resolve("conversations").resolve(UUID_B + ".translated.json.bak")));
        // Prune nothing else: the CLI-owned cache stays byte-identical.
        assertTrue(java.util.Arrays.equals(
                cacheBefore,
                Files.readAllBytes(home.resolve("cache").resolve("conversation_metadata.json"))));
        assertTrue(java.util.Arrays.equals(summariesBytes, Files.readAllBytes(summariesDb)));
        assertTrue(java.util.Arrays.equals(lastConvBytes, Files.readAllBytes(lastConv)));
    }

    @Test
    public void deleteRefusesWhitelistViolationsAndDeletesNothing() throws Exception {
        Path home = cliHome();
        createConversationDb(home, UUID_A, userStep("hello"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        assertFalse(reader.deleteSession("../" + UUID_A, PROJECT));
        assertFalse(reader.deleteSession("a/b", PROJECT));
        // Nothing was removed.
        assertTrue(Files.exists(home.resolve("conversations").resolve(UUID_A + ".db")));
    }

    @Test
    public void liveDatabaseDecodesStepMetadataUsageOntoAssistantEnvelope() throws Exception {
        Path home = cliHome();
        Path db = home.resolve("conversations").resolve(UUID_A + ".db");
        Files.createDirectories(db.getParent());
        byte[] agentPayload = protoMessage(20, protoField(1, "Reply with usage."));
        ByteArrayOutputStream usageStats = new ByteArrayOutputStream();
        writeVarint(usageStats, (2L << 3) | 0);
        writeVarint(usageStats, 3486L);
        writeVarint(usageStats, (3L << 3) | 0);
        writeVarint(usageStats, 236L);
        writeVarint(usageStats, (5L << 3) | 0);
        writeVarint(usageStats, 228502L);
        writeVarint(usageStats, (9L << 3) | 0);
        writeVarint(usageStats, 83L);
        byte[] metadata = protoMessage(9, usageStats.toByteArray());
        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + db.toAbsolutePath());
             Statement statement = conn.createStatement()) {
            statement.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, "
                    + "status INTEGER, metadata BLOB, step_payload BLOB)");
            try (PreparedStatement insert = conn.prepareStatement(
                    "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (1, 15, 3, ?, ?)")) {
                insert.setBytes(1, metadata);
                insert.setBytes(2, agentPayload);
                insert.executeUpdate();
            }
        }
        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);
        assertEquals(1, messages.size());
        JsonObject msgObj = messages.get(0).getAsJsonObject("message");
        assertTrue(msgObj.has("usage"));
        JsonObject usage = msgObj.getAsJsonObject("usage");
        assertEquals(3486, usage.get("input_tokens").getAsInt());
        assertEquals(236, usage.get("output_tokens").getAsInt());
        assertEquals(228502, usage.get("cache_read_input_tokens").getAsInt());
        assertEquals(83, usage.get("thinking_tokens").getAsInt());
        assertTrue(messages.get(0).has("turnUsage"));
        JsonObject turnUsage = messages.get(0).getAsJsonObject("turnUsage");
        assertEquals(3486, turnUsage.get("input_tokens").getAsInt());
        assertEquals(236, turnUsage.get("output_tokens").getAsInt());
        assertEquals(228502, turnUsage.get("cache_read_input_tokens").getAsInt());
        assertEquals(83, turnUsage.get("thinking_tokens").getAsInt());
    }

    @Test
    public void multiStepTurnSumsTurnUsageAndAttachesSilentStepUsageToToolEnvelope() throws Exception {
        Path home = cliHome();
        Path db = home.resolve("conversations").resolve(UUID_A + ".db");
        Files.createDirectories(db.getParent());
        byte[] userPayload1 = protoMessage(19, protoField(2, "First prompt"));
        byte[] call = concat(
                protoField(1, "call-1"),
                protoField(2, "read_file"),
                protoField(3, "{\"Path\":\"/tmp/a\"}"));
        byte[] toolPayload = concat(
                protoMessage(5, protoMessage(4, call)),
                protoMessage(140, concat(
                        protoMessage(1, concat(
                                protoField(1, "toolSummary"),
                                protoField(2, "Read file"))),
                        protoField(2, "contents"))));
        byte[] agentPayload2 = protoMessage(20, protoField(1, "Done."));
        byte[] userPayload2 = protoMessage(19, protoField(2, "Second prompt"));

        byte[] meta1 = encodeUsageMetadata(1000L, 50L, 2000L, 10L);
        byte[] meta2 = encodeUsageMetadata(1200L, 80L, 2500L, 30L);
        byte[] meta3 = encodeUsageMetadata(9999L, 999L, 8888L, 77L);

        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + db.toAbsolutePath());
             Statement statement = conn.createStatement()) {
            statement.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, "
                    + "status INTEGER, metadata BLOB, step_payload BLOB)");
            try (PreparedStatement insert = conn.prepareStatement(
                    "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, 3, ?, ?)")) {
                // Turn 1: user -> silent agent (meta1) -> tool -> final agent (meta2)
                insertStepRow(insert, 1, 14, null, userPayload1);
                insertStepRow(insert, 2, 15, meta1, new byte[0]);
                insertStepRow(insert, 3, 132, null, toolPayload);
                insertStepRow(insert, 4, 15, meta2, agentPayload2);
                // Turn 2: user -> silent agent with no visible output (must not overwrite Turn 1)
                insertStepRow(insert, 5, 14, null, userPayload2);
                insertStepRow(insert, 6, 15, meta3, new byte[0]);
            }
        }

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);
        // Expected envelopes: [0] user1, [1] assistant(tool_use), [2] user(tool_result), [3] assistant(Done.), [4] user2
        assertEquals(5, messages.size());

        JsonObject toolAssistant = messages.get(1);
        assertFalse(toolAssistant.has("turnUsage"));
        JsonObject toolStepUsage = toolAssistant.getAsJsonObject("message").getAsJsonObject("usage");
        assertEquals(1000, toolStepUsage.get("input_tokens").getAsInt());
        assertEquals(50, toolStepUsage.get("output_tokens").getAsInt());
        assertEquals(2000, toolStepUsage.get("cache_read_input_tokens").getAsInt());
        assertEquals(10, toolStepUsage.get("thinking_tokens").getAsInt());

        JsonObject finalAssistant = messages.get(3);
        JsonObject finalStepUsage = finalAssistant.getAsJsonObject("message").getAsJsonObject("usage");
        assertEquals(1200, finalStepUsage.get("input_tokens").getAsInt());
        assertEquals(80, finalStepUsage.get("output_tokens").getAsInt());
        assertEquals(2500, finalStepUsage.get("cache_read_input_tokens").getAsInt());
        assertEquals(30, finalStepUsage.get("thinking_tokens").getAsInt());

        JsonObject turnUsage = finalAssistant.getAsJsonObject("turnUsage");
        assertEquals(2200, turnUsage.get("input_tokens").getAsInt());
        assertEquals(130, turnUsage.get("output_tokens").getAsInt());
        assertEquals(4500, turnUsage.get("cache_read_input_tokens").getAsInt());
        assertEquals(40, turnUsage.get("thinking_tokens").getAsInt());
    }

    // ------------------------------------------------------------------
    // STORY-003: newline tool results, lazy query fallback, step error status, deleteOnExit
    // ------------------------------------------------------------------

    @Test
    public void toolResultStartingWithNewlineIsNotTruncatedAsProtobufWrapper() throws Exception {
        // AC-1: A plain UTF-8 tool output starting with '\n' (0x0A) must not be
        // truncated by misinterpreting 0x0A as a protobuf field-1 length-delimited tag.
        String gitStatusOutput = """

        # On branch main
        # Changes to be committed:
        #   (use "git restore --staged <file>..." to unstage)
        #\tnew file:   src/main/App.java
        #
        # Untracked files:
        #\tnotes.txt
        # padding!
        """;
        assertEquals(175, gitStatusOutput.length());

        Path home = cliHome();
        byte[] call = concat(
                protoField(1, "call_git_status"),
                protoField(2, "run_command"),
                protoField(3, "{\"CommandLine\":\"git status\"}"));

        createLiveConversationDb(home, UUID_A,
                liveStep(15, protoMessage(20, protoMessage(7, call))),
                liveStep(132, concat(
                        protoMessage(5, protoMessage(4, call)),
                        protoMessage(140, concat(
                                protoMessage(1, concat(
                                        protoField(1, "toolSummary"),
                                        protoField(2, "git status"))),
                                protoField(2, gitStatusOutput))))));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        JsonObject toolResult = findBlock(messages, "tool_result");
        assertEquals(gitStatusOutput, toolResult.get("content").getAsString());
    }

    @Test
    public void plainTextThatAlsoParsesAsProtobufIsNotUnwrapped() throws Exception {
        // "\n\n## Acknowledgements\n" is a complete protobuf by accident: field 1
        // "## Acknowl" plus two fixed32 fields ('e' = field 12, wire type 5).
        String output = "\n\n## Acknowledgements\n";
        Path home = cliHome();
        byte[] call = concat(
                protoField(1, "call_cat"),
                protoField(2, "run_command"),
                protoField(3, "{\"CommandLine\":\"cat README.md\"}"));
        createLiveConversationDb(home, UUID_A,
                liveStep(15, protoMessage(20, protoMessage(7, call))),
                liveStep(132, concat(
                        protoMessage(5, protoMessage(4, call)),
                        protoMessage(140, concat(
                                protoMessage(1, concat(
                                        protoField(1, "toolSummary"),
                                        protoField(2, "cat"))),
                                protoField(2, output))))));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        assertEquals(output, findBlock(messages, "tool_result").get("content").getAsString());
    }

    @Test
    public void multiFieldToolResultKeepsField1TextIncludingLeadingNewline() throws Exception {
        // Live 140.2 blobs are a complete protobuf (field 1 text plus fields 3/6/7),
        // not a single field-1 frame. Field 1 must survive, including a leading newline.
        String result = "\nfull tool output that must survive trailing fields";
        Path home = cliHome();
        byte[] call = concat(
                protoField(1, "call_multi"),
                protoField(2, "run_command"),
                protoField(3, "{\"CommandLine\":\"true\"}"));
        createLiveConversationDb(home, UUID_A,
                liveStep(15, protoMessage(20, protoMessage(7, call))),
                liveStep(132, concat(
                        protoMessage(5, protoMessage(4, call)),
                        protoMessage(140, concat(
                                protoMessage(1, concat(
                                        protoField(1, "toolSummary"),
                                        protoField(2, "summary"))),
                                protoMessage(2, concat(
                                        protoField(1, result),
                                        protoField(3, "meta"),
                                        protoField(6, "tail"))))))));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);

        JsonObject toolResult = findBlock(messages, "tool_result");
        assertEquals(result, toolResult.get("content").getAsString());
        assertFalse(toolResult.get("is_error").getAsBoolean());
    }

    @Test
    public void getSessionMessagesRetriesOnTempCopyWhenLazyQueryThrowsSqlException() throws Exception {
        // AC-2: getSessionMessages wraps both openReadOnlyConnection and readStepsIntoEnvelopes
        // in the fallback try/catch, so lazy SQLite query failures fall back to copyWithSidecarsToTemp.
        Path home = cliHome();
        createConversationDb(home, UUID_A, userStep("hello from copy"));

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson()) {
            private boolean firstCall = true;

            @Override
            Connection openReadOnlyConnection(Path database) throws SQLException {
                Connection real = super.openReadOnlyConnection(database);
                if (firstCall) {
                    firstCall = false;
                    return (Connection) Proxy.newProxyInstance(
                            getClass().getClassLoader(),
                            new Class<?>[]{Connection.class},
                            (proxy, method, args) -> {
                                if ("createStatement".equals(method.getName())) {
                                    Statement realStmt = (Statement) method.invoke(real, args);
                                    return Proxy.newProxyInstance(
                                            getClass().getClassLoader(),
                                            new Class<?>[]{Statement.class},
                                            (sProxy, sMethod, sArgs) -> {
                                                if ("executeQuery".equals(sMethod.getName())) {
                                                    throw new SQLException("Simulated lazy SQLite locked query failure");
                                                }
                                                return sMethod.invoke(realStmt, sArgs);
                                            });
                                }
                                return method.invoke(real, args);
                            });
                }
                return real;
            }
        };

        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);
        assertFalse("Messages should be loaded from fallback temp copy when primary query fails", messages.isEmpty());
        assertEquals("hello from copy", textOf(messages.get(0)));
    }

    @Test
    public void failedToolStepSetsIsErrorAndCleansTempFilesWithoutDeleteOnExit() throws Exception {
        // AC-3 & AC-4: steps.status error value propagates is_error = true onto tool_result,
        // and copyWithSidecarsToTemp / deleteTempCopy cleans up temp files.
        Path home = cliHome();
        Path db = home.resolve("conversations").resolve(UUID_A + ".db");
        Files.createDirectories(db.getParent());

        byte[] call = concat(
                protoField(1, "call_failing_cmd"),
                protoField(2, "run_command"),
                protoField(3, "{\"CommandLine\":\"exit 1\"}"));
        byte[] toolPayload = concat(
                protoMessage(5, protoMessage(4, call)),
                protoMessage(140, concat(
                        protoMessage(1, concat(
                                protoField(1, "toolSummary"),
                                protoField(2, "exit 1"))),
                        protoField(2, "Process exited with status 1"))));

        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + db.toAbsolutePath());
             Statement statement = conn.createStatement()) {
            statement.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, "
                    + "status INTEGER, step_payload BLOB)");
            try (PreparedStatement insert = conn.prepareStatement(
                    "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)")) {
                // Step 0: agent initiating the call (status = 3 completed)
                insert.setInt(1, 0);
                insert.setInt(2, 15);
                insert.setInt(3, 3);
                insert.setBytes(4, protoMessage(20, protoMessage(7, call)));
                insert.executeUpdate();

                // Step 1: executed tool with error status = 4
                insert.setInt(1, 1);
                insert.setInt(2, 132);
                insert.setInt(3, 4);
                insert.setBytes(4, toolPayload);
                insert.executeUpdate();
            }
        }

        Files.writeString(home.resolve("conversations").resolve(UUID_A + ".db-wal"), "wal-data", StandardCharsets.UTF_8);
        Files.writeString(home.resolve("conversations").resolve(UUID_A + ".db-shm"), "shm-data", StandardCharsets.UTF_8);

        GeminiHistoryReader reader = new GeminiHistoryReader(home, new Gson());

        // Verify temp copy creation with sidecars and cleanup
        Path tempCopy = reader.copyWithSidecarsToTemp(db);
        assertNotNull(tempCopy);
        assertTrue(Files.exists(tempCopy));
        Path tempDir = tempCopy.getParent();
        assertTrue(Files.exists(tempDir.resolve(UUID_A + ".db-wal")));
        assertTrue(Files.exists(tempDir.resolve(UUID_A + ".db-shm")));

        GeminiHistoryReader.deleteTempCopy(tempCopy);
        assertFalse(Files.exists(tempCopy));
        assertFalse(Files.exists(tempDir.resolve(UUID_A + ".db-wal")));
        assertFalse(Files.exists(tempDir.resolve(UUID_A + ".db-shm")));
        assertFalse(Files.exists(tempDir));

        // Verify session loading propagates is_error = true on tool_result
        List<JsonObject> messages = reader.getSessionMessages(UUID_A, PROJECT);
        assertFalse(messages.isEmpty());
        JsonObject toolResult = findBlock(messages, "tool_result");
        assertNotNull(toolResult);
        assertTrue("Failed tool step with status=4 must set is_error: true",
                toolResult.get("is_error").getAsBoolean());
    }

    private static void insertStepRow(
            PreparedStatement insert,
            int idx,
            int stepType,
            byte[] metadata,
            byte[] payload
    ) throws Exception {
        insert.setInt(1, idx);
        insert.setInt(2, stepType);
        insert.setBytes(3, metadata);
        insert.setBytes(4, payload);
        insert.executeUpdate();
    }

    private static byte[] encodeUsageMetadata(long input, long output, long cacheRead, long thinking) {
        ByteArrayOutputStream usageStats = new ByteArrayOutputStream();
        writeVarint(usageStats, (2L << 3) | 0);
        writeVarint(usageStats, input);
        writeVarint(usageStats, (3L << 3) | 0);
        writeVarint(usageStats, output);
        writeVarint(usageStats, (5L << 3) | 0);
        writeVarint(usageStats, cacheRead);
        writeVarint(usageStats, (9L << 3) | 0);
        writeVarint(usageStats, thinking);
        return protoMessage(9, usageStats.toByteArray());
    }

    // ------------------------------------------------------------------
    // Fixtures
    // ------------------------------------------------------------------

    private Path cliHome() throws Exception {
        Path home = temporaryFolder.newFolder("agy-home").toPath();
        Files.createDirectories(home.resolve("conversations"));
        Files.createDirectories(home.resolve("cache"));
        return home;
    }

    private void writeCache(Path home, String conversationsJson) throws Exception {
        Files.writeString(
                home.resolve("cache").resolve("conversation_metadata.json"),
                conversationsJson,
                StandardCharsets.UTF_8);
    }

    private void writeLastConversations(Path home, String json) throws Exception {
        Files.writeString(
                home.resolve("cache").resolve("last_conversations.json"),
                json,
                StandardCharsets.UTF_8);
    }

    /** Live cache shape: {@code {"conversations":{"<uuid>":{"summary":{...}, ...}}}}. */
    private String cacheWith(String... entries) {
        return "{ \"conversations\": { " + String.join(", ", entries) + " } }";
    }

    /** Self-keyed cache entry: {@code "<uuid>": {summary, is_internal, last_modified_time}}. */
    private String sessionEntry(String uuid, String title, String preview, int numSteps,
                                String updatedAt, String... workspaceUris) {
        StringBuilder uris = new StringBuilder("[");
        for (int i = 0; i < workspaceUris.length; i++) {
            if (i > 0) {
                uris.append(", ");
            }
            uris.append('"').append(workspaceUris[i]).append('"');
        }
        uris.append(']');
        return "\"" + uuid + "\": { \"summary\": { \"ID\": \"" + uuid + "\", \"Title\": \"" + title + "\", "
                + "\"Preview\": \"" + preview + "\", \"NumSteps\": " + numSteps + ", "
                + "\"UpdatedAt\": \"" + updatedAt + "\", \"WorkspaceURIs\": " + uris + ", "
                + "\"AppDataDir\": \"antigravity\", \"ProjectID\": \"p-" + uuid.substring(0, 1)
                + "\", \"AgentName\": \"\" }, "
                + "\"is_internal\": false, "
                + "\"last_modified_time\": \"" + updatedAt + "\" }";
    }

    private static final class Step {
        final int idx;
        final String stepType;
        final byte[] payload;

        Step(int idx, String stepType, byte[] payload) {
            this.idx = idx;
            this.stepType = stepType;
            this.payload = payload;
        }
    }

    private Step userStep(String text) {
        return new Step(0, "user", protoField(1, text));
    }

    private Step agentStep(String text) {
        return new Step(1, "agent", protoField(2, text));
    }

    private Step toolStep(String name, String summary) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(protoField(3, name));
        out.writeBytes(protoField(4, summary));
        // idx 2: the agent fixture step already owns idx 1 and idx is the PRIMARY KEY —
        // inserting both at 1 would violate the constraint before any assertion runs.
        return new Step(2, "tool", out.toByteArray());
    }

    /** One length-delimited protobuf field: {@code (field << 3) | 2, varint len, utf8}. */
    private static byte[] protoField(int fieldNumber, String value) {
        byte[] text = value.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeVarint(out, ((long) fieldNumber << 3) | 2);
        writeVarint(out, text.length);
        out.writeBytes(text);
        return out.toByteArray();
    }

    private static void writeVarint(ByteArrayOutputStream out, long value) {
        long v = value;
        while ((v & ~0x7FL) != 0) {
            out.write((int) ((v & 0x7F) | 0x80));
            v >>>= 7;
        }
        out.write((int) v);
    }

    private void createConversationDb(Path home, String uuid, Step... steps) throws Exception {
        Path db = home.resolve("conversations").resolve(uuid + ".db");
        Files.createDirectories(db.getParent());
        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + db.toAbsolutePath());
             Statement statement = conn.createStatement()) {
            statement.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type TEXT, "
                    + "status TEXT, step_payload BLOB, error_details TEXT)");
            for (Step step : steps) {
                try (PreparedStatement insert = conn.prepareStatement(
                        "INSERT INTO steps (idx, step_type, status, step_payload) "
                                + "VALUES (?, ?, 'done', ?)")) {
                    insert.setInt(1, step.idx);
                    insert.setString(2, step.stepType);
                    insert.setBytes(3, step.payload);
                    insert.executeUpdate();
                }
            }
        }
    }

    /** Live-shaped step: integer step_type, nested envelope payload. */
    private record LiveStep(int stepType, byte[] payload) {
    }

    private static LiveStep liveStep(int stepType, byte[] payload) {
        return new LiveStep(stepType, payload);
    }

    /** Live-schema conversation database: step_type is an INTEGER enum column. */
    private void createLiveConversationDb(Path home, String uuid, LiveStep... steps) throws Exception {
        Path db = home.resolve("conversations").resolve(uuid + ".db");
        Files.createDirectories(db.getParent());
        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + db.toAbsolutePath());
             Statement statement = conn.createStatement()) {
            statement.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, "
                    + "status INTEGER, step_payload BLOB, error_details BLOB)");
            int idx = 0;
            for (LiveStep step : steps) {
                try (PreparedStatement insert = conn.prepareStatement(
                        "INSERT INTO steps (idx, step_type, status, step_payload) "
                                + "VALUES (?, ?, 3, ?)")) {
                    insert.setInt(1, idx++);
                    insert.setInt(2, step.stepType());
                    insert.setBytes(3, step.payload());
                    insert.executeUpdate();
                }
            }
        }
    }

    /** agy stores the workspace URI in trajectory_metadata_blob (field 1.1 and field 7). */
    private void writeTrajectoryWorkspace(Path home, String uuid, String workspaceUri) throws Exception {
        Path db = home.resolve("conversations").resolve(uuid + ".db");
        byte[] blob = concat(
                protoMessage(1, protoField(1, workspaceUri)),
                protoField(7, workspaceUri));
        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + db.toAbsolutePath());
             Statement statement = conn.createStatement()) {
            statement.execute("CREATE TABLE trajectory_metadata_blob (id INTEGER PRIMARY KEY, data BLOB)");
            try (PreparedStatement insert = conn.prepareStatement(
                    "INSERT INTO trajectory_metadata_blob (id, data) VALUES (1, ?)")) {
                insert.setBytes(1, blob);
                insert.executeUpdate();
            }
        }
    }

    /** One length-delimited protobuf field carrying a nested message. */
    private static byte[] protoMessage(int fieldNumber, byte[] content) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeVarint(out, ((long) fieldNumber << 3) | 2);
        writeVarint(out, content.length);
        out.writeBytes(content);
        return out.toByteArray();
    }

    private static byte[] concat(byte[] first, byte[]... rest) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(first);
        for (byte[] bytes : rest) {
            out.writeBytes(bytes);
        }
        return out.toByteArray();
    }

    private static JsonObject parse(String json) {
        return com.google.gson.JsonParser.parseString(json).getAsJsonObject();
    }

    /** Names of the reader's temp directories currently present in {@code tmp}. */
    private static java.util.Set<String> geminiTempDirs(Path tmp) throws Exception {
        java.util.Set<String> names = new java.util.TreeSet<>();
        if (Files.isDirectory(tmp)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(tmp, "gemini-history-*")) {
                for (Path dir : stream) {
                    names.add(dir.getFileName().toString());
                }
            }
        }
        return names;
    }

    private static JsonObject bySessionId(JsonArray sessions, String sessionId) {
        for (JsonElement element : sessions) {
            JsonObject session = element.getAsJsonObject();
            if (sessionId.equals(session.get("sessionId").getAsString())) {
                return session;
            }
        }
        throw new AssertionError("no session with id " + sessionId);
    }

    /** First text block of the envelope's message content (the text contract). */
    private static String textOf(JsonObject envelope) {
        for (JsonElement element : envelope.getAsJsonObject("message").getAsJsonArray("content")) {
            JsonObject block = element.getAsJsonObject();
            if (block.has("text")) {
                return block.get("text").getAsString();
            }
        }
        throw new AssertionError("no text block in envelope");
    }

    /** The content block with the given type across all emitted envelopes. */
    private static JsonObject findBlock(List<JsonObject> messages, String blockType) {
        for (JsonObject message : messages) {
            for (JsonElement element : message.getAsJsonObject("message").getAsJsonArray("content")) {
                JsonObject block = element.getAsJsonObject();
                if (blockType.equals(block.get("type").getAsString())) {
                    return block;
                }
            }
        }
        throw new AssertionError("no " + blockType + " block emitted");
    }
}

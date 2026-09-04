package com.github.claudecodegui.provider.gemini;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.Instant;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
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
 * (user text under field 19.2, agent text + tool calls under 20.3 / 20.7, executed
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
        // discover the conversation databases (title falls back to the id
        // because no summaries source is usable) and must not throw.
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
                assertEquals(UUID_A, element.getAsJsonObject().get("title").getAsString());
            }
        }
        assertTrue(found);
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
        // Other conversations are untouched — db and sidecars alike.
        assertTrue(Files.exists(home.resolve("conversations").resolve(UUID_B + ".db")));
        assertTrue(Files.exists(home.resolve("conversations").resolve(UUID_B + ".db-shm")));
        assertTrue(Files.exists(home.resolve("conversations").resolve(UUID_B + ".db-wal")));
        // Prune nothing else: the CLI-owned cache stays byte-identical.
        assertTrue(java.util.Arrays.equals(
                cacheBefore,
                Files.readAllBytes(home.resolve("cache").resolve("conversation_metadata.json"))));
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

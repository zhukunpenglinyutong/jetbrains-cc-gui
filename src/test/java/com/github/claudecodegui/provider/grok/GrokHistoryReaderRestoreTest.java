package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.provider.common.SessionHistoryNotFoundException;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class GrokHistoryReaderRestoreTest {
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void missingRestoreIsReportedAsNotFoundWhileLegacyListingKeepsItsEmptyFallback() throws Exception {
        GrokHistoryReader reader = new GrokHistoryReader(temporary.newFolder("sessions").toPath(), new Gson());
        assertTrue(reader.getSessionMessages("missing-session", "/fixture").isEmpty());
        assertThrows(SessionHistoryNotFoundException.class,
                () -> reader.getSessionMessages("missing-session", "/fixture", () -> false));
    }

    @Test
    public void existingSessionDirectoryWithoutItsTranscriptStaysRetryable() throws Exception {
        Path sessions = temporary.newFolder("transcript-pending").toPath();
        Files.createDirectories(sessions.resolve("encoded-workspace").resolve("pending-session"));
        GrokHistoryReader reader = new GrokHistoryReader(sessions, new Gson());

        assertTrue(reader.getSessionMessages("pending-session", "/fixture").isEmpty());
        IOException error = assertThrows(IOException.class,
                () -> reader.getSessionMessages("pending-session", "/fixture", () -> false));
        assertFalse(error instanceof java.nio.file.NoSuchFileException);
    }

    @Test
    public void unreadableSessionsRootIsARetryableFailureInsteadOfMissingHistory() throws Exception {
        Assume.assumeTrue("POSIX permissions are required",
                FileSystems.getDefault().supportedFileAttributeViews().contains("posix"));
        Path sessions = temporary.newFolder("unreadable-sessions").toPath();
        Files.createDirectories(sessions.resolve("encoded-workspace"));
        Set<PosixFilePermission> original = Files.getPosixFilePermissions(sessions);
        Files.setPosixFilePermissions(sessions, Set.of());
        try {
            Assume.assumeTrue("Permission checks are bypassed for this user", !Files.isReadable(sessions));
            GrokHistoryReader reader = new GrokHistoryReader(sessions, new Gson());

            assertTrue(reader.getSessionMessages("session", "/fixture").isEmpty());
            assertThrows(IOException.class, () -> reader.getSessionMessages("session", "/fixture", () -> false));
        } finally {
            Files.setPosixFilePermissions(sessions, original);
        }
    }

    @Test
    public void stripsGlobalGrokRulesAndAppendedContextFromRestoredUserMessagesAndTitle() throws Exception {
        Path sessionsRoot = temporary.newFolder("sessions-sanitize").toPath();
        String cwd = "/work/my-project";
        String encodedCwd = GrokHistoryReader.encodeCwd(cwd);
        Path sessionDir = sessionsRoot.resolve(encodedCwd).resolve("session-sanitize-1");
        Files.createDirectories(sessionDir);

        String chatHistory = "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":"
                + "\"<user_query>hi\\n\\n## Global Grok Rules (~/.grok/grok-rules.md)\\n\\n- Never read large files\\n\\n"
                + "## IDE Context (opened files)\\n```json\\n{\\\"active\\\":\\\"App.java\\\"}\\n```</user_query>\"}]}\n"
                + "{\"type\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Hello!\"}]}\n";
        Files.writeString(sessionDir.resolve("chat_history.jsonl"), chatHistory, StandardCharsets.UTF_8);

        GrokHistoryReader reader = new GrokHistoryReader(sessionsRoot, new Gson());
        List<JsonObject> messages = reader.getSessionMessages("session-sanitize-1", cwd);
        assertEquals(2, messages.size());

        JsonObject userMsg = messages.get(0);
        String restoredText = userMsg.getAsJsonObject("message")
                .getAsJsonArray("content")
                .get(0).getAsJsonObject()
                .get("text").getAsString();
        assertEquals("hi", restoredText);

        List<GrokHistoryReader.SessionInfo> sessions = reader.listAllSessions();
        assertEquals(1, sessions.size());
        assertEquals("hi", sessions.get(0).title);
    }

    @Test
    public void restoresContextWindowAndUsageTotalsFromCompanionFiles() throws Exception {
        Path sessionsRoot = temporary.newFolder("sessions-enrich").toPath();
        String cwd = "/work/my-project";
        Path sessionDir = sessionsRoot.resolve(GrokHistoryReader.encodeCwd(cwd)).resolve("session-enrich-1");
        Files.createDirectories(sessionDir);
        Files.writeString(sessionDir.resolve("chat_history.jsonl"), TWO_TURN_CHAT, StandardCharsets.UTF_8);

        String usageJson = """
                {
                  "primaryModelId": "grok-4.7",
                  "totalTokens": 23686,
                  "inputTokens": 20000,
                  "outputTokens": 3686,
                  "cacheReadTokens": 1000,
                  "cacheWriteTokens": 500
                }
                """;
        Files.writeString(sessionDir.resolve("usage.json"), usageJson, StandardCharsets.UTF_8);
        Files.writeString(sessionDir.resolve("signals.json"), """
                {
                  "contextTokensUsed": 23686,
                  "contextWindowTokens": 256000
                }
                """, StandardCharsets.UTF_8);

        GrokHistoryReader reader = new GrokHistoryReader(sessionsRoot, new Gson());
        List<JsonObject> messages = reader.getSessionMessages("session-enrich-1", cwd);
        assertEquals(4, messages.size());

        JsonObject sessionUsage = lastAssistantUsage(messages);
        assertEquals(23686, sessionUsage.get("total_tokens").getAsInt());
        assertEquals(256000, sessionUsage.get("model_context_window").getAsInt());

        GrokUsageAggregator aggregator = new GrokUsageAggregator(reader, null);
        GrokUsageAggregator.ProjectStatistics stats = aggregator.getProjectStatistics(cwd, 0);
        assertEquals(1, stats.sessions.size());
        GrokUsageAggregator.SessionSummary summary = stats.sessions.get(0);
        assertEquals("grok-4.7", summary.model);
        assertEquals(23686L, summary.usage.totalTokens);
        assertEquals("inputTokens must exclude cache reads and writes", 18500L, summary.usage.inputTokens);
        assertEquals(3686L, summary.usage.outputTokens);
        assertEquals(1000L, summary.usage.cacheReadTokens);
        assertEquals(500L, summary.usage.cacheWriteTokens);
    }

    @Test
    public void usageTotalsSumTurnsWhenSessionTotalIsMissing() throws Exception {
        Path sessionsRoot = temporary.newFolder("sessions-turn-totals").toPath();
        String cwd = "/work/turn-totals";
        Path sessionDir = sessionsRoot.resolve(GrokHistoryReader.encodeCwd(cwd)).resolve("session-turns");
        Files.createDirectories(sessionDir);
        Files.writeString(sessionDir.resolve("chat_history.jsonl"), TWO_TURN_CHAT, StandardCharsets.UTF_8);
        Files.writeString(sessionDir.resolve("usage.json"), """
                {
                  "turns": [
                    { "turnId": 1, "usage": { "inputTokens": 10000, "cachedReadTokens": 500, "outputTokens": 1500, "totalTokens": 11500 } },
                    { "turnId": 2, "usage": { "inputTokens": 10000, "cachedReadTokens": 500, "outputTokens": 2186, "totalTokens": 12186 } }
                  ]
                }
                """, StandardCharsets.UTF_8);

        GrokHistoryReader reader = new GrokHistoryReader(sessionsRoot, new Gson());
        GrokUsageAggregator.SessionSummary summary =
                new GrokUsageAggregator(reader, null).getProjectStatistics(cwd, 0).sessions.get(0);
        assertEquals(23686L, summary.usage.totalTokens);
        assertEquals(19000L, summary.usage.inputTokens);
        assertEquals(1000L, summary.usage.cacheReadTokens);
        assertEquals(3686L, summary.usage.outputTokens);
    }

    @Test
    public void ringFallsBackToLatestStepInUpdatesWhenSignalsAreMissing() throws Exception {
        Path sessionsRoot = temporary.newFolder("sessions-updates").toPath();
        String cwd = "/work/updates-only";
        Path sessionDir = sessionsRoot.resolve(GrokHistoryReader.encodeCwd(cwd)).resolve("session-updates");
        Files.createDirectories(sessionDir);
        Files.writeString(sessionDir.resolve("chat_history.jsonl"), TWO_TURN_CHAT, StandardCharsets.UTF_8);
        Files.writeString(sessionDir.resolve("usage.json"), "{\"primaryModelId\":\"grok-4.7\"}", StandardCharsets.UTF_8);
        // Two steps of one turn, then the turn's cumulative usage, which must not drive the ring.
        Files.writeString(sessionDir.resolve("updates.jsonl"), """
                {"update":{"sessionUpdate":"response_completed","usage":{"input_tokens":500,"cache_read_input_tokens":20000,"output_tokens":200,"total_tokens":20700}}}
                not json
                {"update":{"sessionUpdate":"response_completed","usage":{"input_tokens":554,"cache_read_input_tokens":23168,"output_tokens":356,"total_tokens":24086}}}
                {"update":{"sessionUpdate":"turn_completed","usage":{"totalTokens":44786,"inputTokens":44222,"cachedReadTokens":43168,"outputTokens":556,"modelCalls":2}}}
                """, StandardCharsets.UTF_8);

        GrokHistoryReader reader = new GrokHistoryReader(sessionsRoot, new Gson());
        JsonObject sessionUsage = lastAssistantUsage(reader.getSessionMessages("session-updates", cwd));
        assertEquals(24086, sessionUsage.get("total_tokens").getAsInt());
        assertEquals(256000, sessionUsage.get("model_context_window").getAsInt());
    }

    @Test
    public void historyIsNotStampedWithPerTurnFooterDataTheTransportDrops() throws Exception {
        Path sessionsRoot = temporary.newFolder("sessions-no-footer").toPath();
        String cwd = "/work/no-footer";
        Path sessionDir = sessionsRoot.resolve(GrokHistoryReader.encodeCwd(cwd)).resolve("session-no-footer");
        Files.createDirectories(sessionDir);
        Files.writeString(sessionDir.resolve("chat_history.jsonl"), TWO_TURN_CHAT, StandardCharsets.UTF_8);
        Files.writeString(sessionDir.resolve("updates.jsonl"), """
                {"type":"_x.ai/session/update","turn":1,"elapsed_ms":1250}
                {"type":"_x.ai/session/update","turn":2,"elapsed_ms":3400}
                """, StandardCharsets.UTF_8);

        List<JsonObject> messages = new GrokHistoryReader(sessionsRoot, new Gson())
                .getSessionMessages("session-no-footer", cwd);
        for (JsonObject message : messages) {
            assertFalse(message.has("durationMs"));
            assertFalse(message.has("turnUsage"));
        }
    }

    @Test
    public void malformedContentBlockTypeDoesNotBreakHistoryLoad() throws Exception {
        Path sessionsRoot = temporary.newFolder("sessions-malformed").toPath();
        String cwd = "/work/malformed";
        Path sessionDir = sessionsRoot.resolve(GrokHistoryReader.encodeCwd(cwd)).resolve("session-malformed");
        Files.createDirectories(sessionDir);
        Files.writeString(sessionDir.resolve("chat_history.jsonl"), """
                {"type":"user","message":{"content":[{"type":"text","text":"Prompt"}]}}
                {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading"}]}}
                {"type":"user","message":{"content":[{"type":null},{"type":["odd"]},{"type":"tool_result","tool_use_id":"call-1","content":"file body"}]}}
                {"type":{"x":1}}
                {"type":"assistant","content":"","tool_calls":[{"id":{"x":1},"function":{"name":"read","arguments":"{}"}}]}
                {"type":"tool_result","tool_call_id":["odd"],"content":"listing"}
                {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done"}]}}
                """, StandardCharsets.UTF_8);

        List<JsonObject> messages = new GrokHistoryReader(sessionsRoot, new Gson())
                .getSessionMessages("session-malformed", cwd);
        assertEquals(6, messages.size());
        assertEquals("Done", messages.get(5).getAsJsonObject("message").getAsJsonArray("content")
                .get(0).getAsJsonObject().get("text").getAsString());
        JsonObject toolResult = messages.get(2).getAsJsonObject("message").getAsJsonArray("content")
                .get(0).getAsJsonObject();
        assertEquals("tool_result", toolResult.get("type").getAsString());
        assertEquals("call-1", toolResult.get("tool_use_id").getAsString());
    }

    @Test
    public void ledgerOnlySessionKeepsItsCachedTokens() throws Exception {
        Path ledgerPath = temporary.newFile("grok-usage-ledger.jsonl").toPath();
        GrokUsageLedger ledger = new GrokUsageLedger(ledgerPath);
        JsonObject turn = new JsonObject();
        turn.addProperty("totalTokens", 47330);
        turn.addProperty("inputTokens", 46915);
        turn.addProperty("cachedReadTokens", 24960);
        turn.addProperty("outputTokens", 415);
        ledger.record("ledger-only", "grok-4.7", "/work/ledger", turn);

        GrokHistoryReader reader = new GrokHistoryReader(temporary.newFolder("sessions-empty").toPath(), new Gson());
        GrokUsageAggregator.SessionSummary summary =
                new GrokUsageAggregator(reader, ledger).getProjectStatistics("/work/ledger", 0).sessions.get(0);
        assertEquals(21955L, summary.usage.inputTokens);
        assertEquals(24960L, summary.usage.cacheReadTokens);
        assertEquals(415L, summary.usage.outputTokens);
        assertEquals(47330L, summary.usage.totalTokens);
    }

    @Test
    public void cancellingDuringTheUpdatesFallbackStopsTheLoad() throws Exception {
        Path sessionDir = temporary.newFolder("session-cancel").toPath();
        Files.writeString(sessionDir.resolve("updates.jsonl"),
                "{\"update\":{\"sessionUpdate\":\"response_completed\",\"usage\":{\"total_tokens\":10}}}\n",
                StandardCharsets.UTF_8);
        JsonObject assistant = new JsonObject();
        assistant.addProperty("type", "assistant");
        List<JsonObject> messages = new java.util.ArrayList<>(List.of(assistant));

        assertThrows(java.util.concurrent.CancellationException.class,
                () -> GrokSessionCompanionFiles.restoreSessionContext(sessionDir, messages, () -> true));
    }

    private static final String TWO_TURN_CHAT = """
            {"type":"user","message":{"content":[{"type":"text","text":"Turn 1 prompt"}]}}
            {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Turn 1 reply"}]}}
            {"type":"user","message":{"content":[{"type":"text","text":"Turn 2 prompt"}]}}
            {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Turn 2 reply"}]}}
            """;

    private static JsonObject lastAssistantUsage(List<JsonObject> messages) {
        JsonObject last = messages.get(messages.size() - 1);
        assertEquals("assistant", last.get("type").getAsString());
        JsonObject message = last.getAsJsonObject("message");
        assertTrue("Last assistant message must carry usage", message.has("usage"));
        return message.getAsJsonObject("usage");
    }
}

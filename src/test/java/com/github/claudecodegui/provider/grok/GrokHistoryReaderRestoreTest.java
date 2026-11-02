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
    public void restoresTurnUsageDurationAndContextWindowFromCompanionFiles() throws Exception {
        Path sessionsRoot = temporary.newFolder("sessions-enrich").toPath();
        String cwd = "/work/my-project";
        String encodedCwd = GrokHistoryReader.encodeCwd(cwd);
        Path sessionDir = sessionsRoot.resolve(encodedCwd).resolve("session-enrich-1");
        Files.createDirectories(sessionDir);

        String chatHistory = """
                {"type":"user","message":{"content":[{"type":"text","text":"Turn 1 prompt"}]}}
                {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Turn 1 reply"}]}}
                {"type":"user","message":{"content":[{"type":"text","text":"Turn 2 prompt"}]}}
                {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Turn 2 reply"}]}}
                """;
        Files.writeString(sessionDir.resolve("chat_history.jsonl"), chatHistory, StandardCharsets.UTF_8);

        String usageJson = """
                {
                  "primaryModelId": "grok-4.7",
                  "totalTokens": 23686,
                  "inputTokens": 20000,
                  "outputTokens": 3686,
                  "cacheReadTokens": 1000,
                  "cacheWriteTokens": 500,
                  "turns": [
                    {
                      "turnId": 1,
                      "usage": {
                        "inputTokens": 10000,
                        "outputTokens": 1500,
                        "cachedReadTokens": 500,
                        "totalTokens": 11500
                      }
                    },
                    {
                      "turnId": 2,
                      "usage": {
                        "inputTokens": 10000,
                        "outputTokens": 2186,
                        "cachedReadTokens": 500,
                        "totalTokens": 12186
                      }
                    }
                  ]
                }
                """;
        Files.writeString(sessionDir.resolve("usage.json"), usageJson, StandardCharsets.UTF_8);

        String signalsJson = """
                {
                  "contextTokensUsed": 23686,
                  "contextWindowTokens": 256000
                }
                """;
        Files.writeString(sessionDir.resolve("signals.json"), signalsJson, StandardCharsets.UTF_8);

        String updatesJsonl = """
                {"type":"_x.ai/session/update","turn":1,"elapsed_ms":1250}
                {"type":"_x.ai/session/update","turn":2,"elapsed_ms":3400}
                """;
        Files.writeString(sessionDir.resolve("updates.jsonl"), updatesJsonl, StandardCharsets.UTF_8);

        GrokHistoryReader reader = new GrokHistoryReader(sessionsRoot, new Gson());
        List<JsonObject> messages = reader.getSessionMessages("session-enrich-1", cwd);
        assertEquals(4, messages.size());

        JsonObject turn1Assistant = messages.get(1);
        assertTrue("Turn 1 assistant must carry turnUsage", turn1Assistant.has("turnUsage"));
        JsonObject turn1Usage = turn1Assistant.getAsJsonObject("turnUsage");
        assertEquals(9500, turn1Usage.get("input_tokens").getAsInt());
        assertEquals(500, turn1Usage.get("cache_read_input_tokens").getAsInt());
        assertEquals(1500, turn1Usage.get("output_tokens").getAsInt());
        assertEquals(11500, turn1Usage.get("total_tokens").getAsInt());
        assertTrue("Turn 1 assistant must carry durationMs", turn1Assistant.has("durationMs"));
        assertEquals(1250L, turn1Assistant.get("durationMs").getAsLong());

        JsonObject turn2Assistant = messages.get(3);
        assertTrue("Turn 2 assistant must carry turnUsage", turn2Assistant.has("turnUsage"));
        assertTrue("Turn 2 assistant must carry durationMs", turn2Assistant.has("durationMs"));
        assertEquals(3400L, turn2Assistant.get("durationMs").getAsLong());

        assertTrue("Last assistant must carry message object", turn2Assistant.has("message"));
        JsonObject msgObj = turn2Assistant.getAsJsonObject("message");
        assertTrue("Last assistant message must carry usage", msgObj.has("usage"));
        JsonObject sessionUsage = msgObj.getAsJsonObject("usage");
        assertEquals(23686, sessionUsage.get("total_tokens").getAsInt());
        assertEquals(256000, sessionUsage.get("model_context_window").getAsInt());

        GrokUsageAggregator aggregator = new GrokUsageAggregator(reader, null);
        GrokUsageAggregator.ProjectStatistics stats = aggregator.getProjectStatistics(cwd, 0);
        assertEquals(1, stats.sessions.size());
        GrokUsageAggregator.SessionSummary summary = stats.sessions.get(0);
        assertEquals("grok-4.7", summary.model);
        assertEquals(23686L, summary.usage.totalTokens);
        assertEquals(20000L, summary.usage.inputTokens);
        assertEquals(3686L, summary.usage.outputTokens);
        assertEquals(1000L, summary.usage.cacheReadTokens);
        assertEquals(500L, summary.usage.cacheWriteTokens);
    }
}

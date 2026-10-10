package com.github.claudecodegui.clawbot;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.UUID;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

public class ClawBotExecutionJournalTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void restartConvertsNonTerminalExecutionToUnknownWithoutMessageBody() throws Exception {
        Path runtime = temporaryFolder.newFolder("execution-journal").toPath();
        ClawBotInboundMessage message = message();
        ClawBotExecutionJournal journal = new ClawBotExecutionJournal(runtime);

        journal.recordAccepted(message, "session-1", 10L);
        journal.markDispatched(message.messageId(), 11L);

        ClawBotExecutionJournal.StatusSnapshot status = new ClawBotExecutionJournal(runtime).status();

        assertTrue(status.available());
        assertEquals(0, status.dispatchedCount());
        assertEquals(1, status.unknownCount());
        String persisted = Files.readString(runtime.resolve("execution-journal.json"), StandardCharsets.UTF_8);
        assertTrue(persisted.contains("provider"));
        assertTrue(!persisted.contains("secret context") && !persisted.contains("message body"));
    }

    @Test
    public void terminalCompletionDeletesHistory() throws Exception {
        Path runtime = temporaryFolder.newFolder("completed-journal").toPath();
        ClawBotInboundMessage message = message();
        ClawBotExecutionJournal journal = new ClawBotExecutionJournal(runtime);

        journal.recordAccepted(message, "session-1", 20L);
        journal.markCompleted(message.messageId(), 21L);
        journal.markCompleted(message.messageId(), 22L);

        ClawBotExecutionJournal journalAfterRestart = new ClawBotExecutionJournal(runtime);
        ClawBotExecutionJournal.StatusSnapshot status = journalAfterRestart.status();

        assertEquals(0, status.completedCount());
        assertEquals(0, status.unknownCount());
        String persisted = Files.readString(runtime.resolve("execution-journal.json"), StandardCharsets.UTF_8);
        assertEquals(0, count(persisted, "executionId"));
    }

    @Test
    public void restartRetainsUnknownExecutionClaimsWithoutEviction() throws Exception {
        Path runtime = temporaryFolder.newFolder("bounded-journal").toPath();
        ClawBotExecutionJournal journal = new ClawBotExecutionJournal(runtime);
        for (int index = 0; index < 260; index++) {
            journal.recordAccepted(message("message-" + index), "session-1", 30L + index);
        }

        ClawBotExecutionJournal.StatusSnapshot status = new ClawBotExecutionJournal(runtime).status();

        assertEquals(0, status.acceptedCount());
        assertEquals(260, status.unknownCount());
    }

    @Test
    public void fullJournalRejectsNewClaimsWithoutEvictingUnknownGuards() throws Exception {
        Path runtime = temporaryFolder.newFolder("execution-full-journal").toPath();
        JsonArray entries = new JsonArray();
        for (int index = 0; index < 2_048; index++) {
            JsonObject entry = new JsonObject();
            entry.addProperty("executionId", UUID.randomUUID().toString());
            entry.addProperty("messageId", "message-" + index);
            entry.addProperty("sessionHandleId", "session-1");
            entry.addProperty("instanceId", "ide-1");
            entry.addProperty("connectionEpoch", 7L);
            entry.addProperty("provider", "codex");
            entry.addProperty("generation", "generation-1");
            entry.addProperty("state", "UNKNOWN");
            entry.addProperty("createdAt", 30L + index);
            entry.addProperty("updatedAt", 30L + index);
            entries.add(entry);
        }
        Files.writeString(runtime.resolve("execution-journal.json"), entries.toString(), StandardCharsets.UTF_8);
        ClawBotExecutionJournal journal = new ClawBotExecutionJournal(runtime);

        java.io.IOException error = assertThrows(java.io.IOException.class,
                () -> journal.recordAccepted(message("overflow"), "session-1", 3_000L));
        ClawBotExecutionJournal.StatusSnapshot status = new ClawBotExecutionJournal(runtime).status();

        assertEquals("CLAWBOT_EXECUTION_JOURNAL_FULL", error.getMessage());
        assertEquals(2_048, status.unknownCount());
    }

    @Test
    public void duplicateExecutionClaimCannotBeRecordedTwice() throws Exception {
        ClawBotExecutionJournal journal = new ClawBotExecutionJournal(
                temporaryFolder.newFolder("execution-duplicate").toPath());
        ClawBotInboundMessage message = message("same-message");

        assertTrue(journal.recordAccepted(message, "session-1", 10L));
        assertFalse(journal.recordAccepted(message, "session-1", 11L));
    }

    private static ClawBotInboundMessage message() {
        return message("message-1");
    }

    private static ClawBotInboundMessage message(String messageId) {
        ClawBotSessionSnapshot session = new ClawBotSessionSnapshot(
                "session-1", "ide-1", "project-1", "Project", "codex",
                Set.of("INBOUND", "ROUTING_V2"), ClawBotSessionStatus.BUSY,
                7L, 1L, 2L, "Chat", "generation-1", 0L);
        return new ClawBotInboundMessage(messageId, "sender-1", "secret context", "message body")
                .forTarget(session);
    }

    private static int count(String value, String token) {
        int count = 0;
        int offset = 0;
        while ((offset = value.indexOf(token, offset)) >= 0) {
            count++;
            offset += token.length();
        }
        return count;
    }
}

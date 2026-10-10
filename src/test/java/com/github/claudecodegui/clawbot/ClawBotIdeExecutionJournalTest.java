package com.github.claudecodegui.clawbot;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class ClawBotIdeExecutionJournalTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void claimsMessageOnlyOnceAndRetainsCompletedGuardUntilReplyAcknowledged() throws Exception {
        Path runtime = temporaryFolder.newFolder("ide-execution").toPath();
        ClawBotIdeExecutionJournal journal = new ClawBotIdeExecutionJournal(runtime);

        assertTrue(journal.tryStart("message-1"));
        assertFalse(journal.tryStart("message-1"));
        journal.markCompleted("message-1");

        ClawBotIdeExecutionJournal restarted = new ClawBotIdeExecutionJournal(runtime);
        assertEquals(ClawBotIdeExecutionJournal.State.COMPLETED, restarted.stateOf("message-1"));
        assertFalse(restarted.tryStart("message-1"));

        restarted.acknowledge("message-1");
        assertEquals(ClawBotIdeExecutionJournal.State.NONE, restarted.stateOf("message-1"));
    }

    @Test
    public void convertsInterruptedExecutionToUnknownWithoutPersistingMessageContent() throws Exception {
        Path runtime = temporaryFolder.newFolder("ide-restart").toPath();
        ClawBotIdeExecutionJournal journal = new ClawBotIdeExecutionJournal(runtime);

        assertTrue(journal.tryStart("message-2"));
        Path stateFile = runtime.resolve("ide-execution-journal.json");
        JsonArray records = JsonParser.parseString(Files.readString(stateFile, StandardCharsets.UTF_8))
                .getAsJsonArray();
        records.get(0).getAsJsonObject().addProperty("ownerProcessId", Long.MAX_VALUE);
        Files.writeString(stateFile, records.toString(), StandardCharsets.UTF_8);

        ClawBotIdeExecutionJournal restarted = new ClawBotIdeExecutionJournal(runtime);

        assertEquals(ClawBotIdeExecutionJournal.State.UNKNOWN, restarted.stateOf("message-2"));
        String persisted = Files.readString(stateFile, StandardCharsets.UTF_8);
        assertTrue(persisted.contains("message-2"));
        assertFalse(persisted.contains("secret context"));
    }

    @Test
    public void separateJournalInstanceDoesNotTreatLiveOwnerClaimAsInterrupted() throws Exception {
        Path runtime = temporaryFolder.newFolder("ide-live-owner").toPath();
        ClawBotIdeExecutionJournal owner = new ClawBotIdeExecutionJournal(runtime);
        ClawBotIdeExecutionJournal observer = new ClawBotIdeExecutionJournal(runtime);

        assertTrue(owner.tryStart("live-message"));

        assertEquals(ClawBotIdeExecutionJournal.State.STARTED, observer.stateOf("live-message"));
        assertFalse(observer.tryStart("live-message"));
    }

    @Test
    public void separateJournalInstancesCannotClaimTheSameMessageConcurrently() throws Exception {
        Path runtime = temporaryFolder.newFolder("ide-concurrent-claim").toPath();
        ClawBotIdeExecutionJournal first = new ClawBotIdeExecutionJournal(runtime);
        ClawBotIdeExecutionJournal second = new ClawBotIdeExecutionJournal(runtime);
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<Boolean> firstClaim = workers.submit(() -> tryClaim(first, ready, start));
            Future<Boolean> secondClaim = workers.submit(() -> tryClaim(second, ready, start));
            assertTrue(ready.await(5, TimeUnit.SECONDS));
            start.countDown();

            assertTrue(firstClaim.get(5, TimeUnit.SECONDS) ^ secondClaim.get(5, TimeUnit.SECONDS));
        } finally {
            workers.shutdownNow();
        }
    }

    @Test
    public void fullJournalFailsClosedAndRetainsEveryUnresolvedGuard() throws Exception {
        Path runtime = temporaryFolder.newFolder("ide-full-journal").toPath();
        JsonArray records = new JsonArray();
        for (int index = 0; index < 2_048; index++) {
            JsonObject record = new JsonObject();
            record.addProperty("messageId", "message-" + index);
            record.addProperty("state", "UNKNOWN");
            record.addProperty("updatedAt", 1L);
            records.add(record);
        }
        Path stateFile = runtime.resolve("ide-execution-journal.json");
        Files.writeString(stateFile, records.toString(), StandardCharsets.UTF_8);
        String before = Files.readString(stateFile, StandardCharsets.UTF_8);
        ClawBotIdeExecutionJournal journal = new ClawBotIdeExecutionJournal(runtime);

        java.io.IOException error = assertThrows(java.io.IOException.class, () -> journal.tryStart("new-message"));

        assertEquals("CLAWBOT_IDE_EXECUTION_JOURNAL_FULL", error.getMessage());
        assertEquals(ClawBotIdeExecutionJournal.State.UNKNOWN, journal.stateOf("message-0"));
        assertEquals(before, Files.readString(stateFile, StandardCharsets.UTF_8));
    }

    private static boolean tryClaim(
            ClawBotIdeExecutionJournal journal, CountDownLatch ready, CountDownLatch start) throws Exception {
        ready.countDown();
        assertTrue(start.await(5, TimeUnit.SECONDS));
        return journal.tryStart("concurrent-message");
    }
}

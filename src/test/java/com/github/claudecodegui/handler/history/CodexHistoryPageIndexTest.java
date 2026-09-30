package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.google.gson.Gson;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

public class CodexHistoryPageIndexTest {
    private Path directory;
    private Path session;
    private CodexHistoryReader reader;
    private final CodexHistoryPageIndex index = new CodexHistoryPageIndex();

    @Before
    public void setup() throws Exception {
        directory = Files.createTempDirectory("codex-page-index-test");
        session = directory.resolve("rollout-fixture.jsonl");
        var constructor = CodexHistoryReader.class.getDeclaredConstructor(Path.class, Gson.class);
        constructor.setAccessible(true);
        reader = constructor.newInstance(directory, new Gson());
    }

    @After
    public void cleanup() throws Exception {
        index.close();
        try (var paths = Files.walk(directory)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        }
    }

    @Test
    public void ignoresNullPayloadTypeWithoutLosingAdjacentMessages() throws Exception {
        assertMalformedRecordIsSkipped("{\"type\":\"response_item\",\"payload\":{\"type\":null}}");
    }

    @Test
    public void ignoresObjectPayloadTypeWithoutLosingAdjacentMessages() throws Exception {
        assertMalformedRecordIsSkipped("{\"type\":\"response_item\",\"payload\":{\"type\":{}}}");
    }

    @Test
    public void ignoresNullFunctionNameWithoutLosingAdjacentMessages() throws Exception {
        assertMalformedRecordIsSkipped("{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":null}}");
    }

    private void assertMalformedRecordIsSkipped(String malformed) throws Exception {
        Files.writeString(session, user("question") + malformed + "\n" + assistant("answer"));
        var expected = HistoryMessageInjector.scanCodexHistoryPage(reader, "fixture", null, 30);
        assertEquals(2, expected.messages.size());
        var actual = index.read(reader, "fixture", null, 30, () -> true);
        assertEquals(expected.messages, actual.messages);
        assertEquals(2, actual.rawRecordCount);
        assertEquals(1, actual.totalTurns);
        var repeated = index.read(reader, "fixture", null, 30, () -> true);
        assertEquals(expected.messages, repeated.messages);
        assertEquals(0, repeated.rawRecordCount);
    }

    @Test
    public void consumerCancellationIsNotSwallowedAsMalformedInput() throws Exception {
        Files.writeString(session, user("question") + assistant("answer"));
        CancellationException cancelled = new CancellationException("consumer cancelled");
        var thrown = assertThrows(CancellationException.class,
                () -> reader.forEachSessionMessage(session, 0, Files.size(session), () -> true, message -> {
                    throw cancelled;
                }));
        assertSame(cancelled, thrown);
    }

    @Test
    public void consecutivePagesDoNotParseStableHistoryAgain() throws Exception {
        StringBuilder history = new StringBuilder();
        for (int turn = 0; turn < 1000; turn++) {
            history.append(user("question-" + turn)).append(assistant("answer-" + turn));
        }
        Files.writeString(session, history);
        var latest = index.read(reader, "fixture", null, 30, () -> true);
        var previous = index.read(reader, "fixture", 970, 30, () -> true);
        var earlier = index.read(reader, "fixture", 940, 30, () -> true);
        assertEquals(1000, latest.totalTurns);
        assertEquals(60, previous.messages.size());
        assertEquals(940, previous.fromTurn);
        assertEquals(2000, latest.rawRecordCount);
        assertEquals(Files.size(session), latest.sourceBytesRead);
        assertEquals(0, previous.sourceBytesRead + earlier.sourceBytesRead);
        assertEquals("Stable pages must not parse the complete JSONL again", 0,
                previous.rawRecordCount + earlier.rawRecordCount);
    }

    @Test
    public void retainsToolIdsAcrossPagesAndAppendedOutput() throws Exception {
        String call = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\","
                + "\"name\":\"exec_command\",\"call_id\":\"cross-turn\",\"arguments\":\"{\\\"cmd\\\":\\\"echo ok\\\"}\"}}\n";
        String output = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\","
                + "\"call_id\":\"cross-turn\",\"output\":\"ok\"}}\n";
        Files.writeString(session, user("first") + call + user("second"));
        index.read(reader, "fixture", null, 1, () -> true);
        Files.writeString(session, output, StandardOpenOption.APPEND);
        var latest = index.read(reader, "fixture", null, 1, () -> true);
        var previous = index.read(reader, "fixture", 1, 1, () -> true);
        var tool = previous.messages.get(1).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        var result = latest.messages.get(1).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals(tool.get("id"), result.get("tool_use_id"));
        assertEquals("ok", result.get("content").getAsString());
        assertEquals(2, latest.totalTurns);
        assertEquals(1, latest.rawRecordCount);
        assertEquals(0, previous.rawRecordCount);
    }

    @Test
    public void appendUpdatesUsageOnAnAlreadyPersistedAssistant() throws Exception {
        Files.writeString(session, user("first") + assistant("answer") + user("second"));
        index.read(reader, "fixture", null, 2, () -> true);
        Files.writeString(session, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{"
                + "\"last_token_usage\":{\"input_tokens\":12,\"output_tokens\":3},\"model_context_window\":200000}}}\n",
                StandardOpenOption.APPEND);
        var previous = index.read(reader, "fixture", 1, 1, () -> true);
        assertEquals(12, previous.messages.get(1).getAsJsonObject("raw").getAsJsonObject("usage").get("input_tokens").getAsInt());
        previous.messages.get(1).addProperty("content", "mutated by caller");
        assertEquals("answer", index.read(reader, "fixture", 1, 1, () -> true).messages.get(1).get("content").getAsString());
    }

    @Test
    public void replacementWithPreservedSizeAndMtimeRebuildsIndex() throws Exception {
        Files.writeString(session, user("old"));
        index.read(reader, "fixture", null, 1, () -> true);
        var modified = Files.getLastModifiedTime(session);
        Path replacement = directory.resolve("replacement.tmp");
        Files.writeString(replacement, user("new"));
        Files.setLastModifiedTime(replacement, modified);
        Files.move(replacement, session, StandardCopyOption.REPLACE_EXISTING);
        var page = index.read(reader, "fixture", null, 1, () -> true);
        assertEquals("new", page.messages.get(0).get("content").getAsString());
        assertEquals(1, page.rawRecordCount);
    }

    /** Rotating validation must eventually visit a rewrite outside both fixed samples. */
    @Test
    public void equalMetadataMiddleRewriteCannotStayCachedForever() throws Exception {
        String before = user("H".repeat(9000)) + user("OLD") + assistant("T".repeat(9000));
        Files.writeString(this.session, before);
        this.index.read(this.reader, "fixture", null, 30, () -> true);
        Files.writeString(this.session, before.replace("OLD", "NEW"));
        // Force a metadata collision on every OS, including Unix filesystems exposing nanosecond ctime.
        var entriesField = CodexHistoryPageIndex.class.getDeclaredField("entries");
        entriesField.setAccessible(true);
        var entries = (java.util.Map<?, ?>) entriesField.get(this.index);
        Object entry = entries.get(this.session);
        var snapshotField = entry.getClass().getDeclaredField("snapshot");
        snapshotField.setAccessible(true);
        var readSnapshot = snapshotField.getType().getDeclaredMethod("read", Path.class);
        readSnapshot.setAccessible(true);
        snapshotField.set(entry, readSnapshot.invoke(null, this.session));
        HistoryMessageInjector.CodexHistoryPage page = null;
        for (int attempt = 0; attempt < (Files.size(this.session) + 4095) / 4096; attempt++) {
            page = this.index.read(this.reader, "fixture", null, 30, () -> true);
            if ("NEW".equals(page.messages.get(1).get("content").getAsString())) break;
        }
        assertNotNull(page);
        assertEquals("NEW", page.messages.get(1).get("content").getAsString());
    }

    @Test
    public void incompleteTrailingJsonIsReplayedWhenCompleted() throws Exception {
        String second = assistant("中文😀");
        Files.writeString(session, user("first") + second.substring(0, second.length() - 6));
        index.read(reader, "fixture", null, 1, () -> true);
        Files.writeString(session, second.substring(second.length() - 6), StandardOpenOption.APPEND);
        var page = index.read(reader, "fixture", null, 1, () -> true);
        assertEquals(1, page.totalTurns);
        assertEquals(2, page.messages.size());
        assertEquals("中文😀", page.messages.get(1).get("content").getAsString());
    }

    @Test
    public void adjacentUserPairAcrossAppendDoesNotCreateAnotherTurn() throws Exception {
        Files.writeString(session, user("same"));
        index.read(reader, "fixture", null, 1, () -> true);
        Files.writeString(session, "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\","
                + "\"content\":[{\"type\":\"input_text\",\"text\":\"same\"}]}}\n" + assistant("reply"), StandardOpenOption.APPEND);
        var page = index.read(reader, "fixture", null, 5, () -> true);
        assertEquals(1, page.totalTurns);
        assertEquals(2, page.messages.size());
        assertEquals(2, page.rawRecordCount);
    }

    @Test
    public void emptyAndInvalidCursorsPreservePaginationSemantics() throws Exception {
        Files.writeString(session, user("first") + assistant("answer"));
        var empty = index.read(reader, "fixture", 0, 30, () -> true);
        assertTrue(empty.messages.isEmpty());
        assertFalse(empty.cursorReset);
        var reset = index.read(reader, "fixture", 999, 30, () -> true);
        assertTrue(reset.cursorReset);
        assertEquals(0, reset.fromTurn);
        assertEquals(1, reset.toTurn);
        assertThrows(IllegalArgumentException.class, () -> index.read(reader, "fixture", -1, 30, () -> true));
        assertThrows(IllegalArgumentException.class, () -> index.read(reader, "fixture", 1, 0, () -> true));
    }

    @Test
    public void cancellationStopsScanAndDiscardsPartialIndex() throws Exception {
        Files.writeString(session, (user("question") + assistant("answer")).repeat(1000));
        AtomicInteger checks = new AtomicInteger();
        var spools = new java.util.ArrayList<Path>();
        assertThrows(CancellationException.class, () -> index.read(reader, "fixture", null, 30, () -> {
            spools.addAll(index.spoolFiles());
            return checks.incrementAndGet() < 30;
        }));
        assertEquals(30, checks.get());
        assertEquals(0, index.size());
        assertFalse(spools.isEmpty());
        assertTrue(spools.stream().noneMatch(Files::exists));
        var complete = index.read(reader, "fixture", null, 30, () -> true);
        assertEquals(1000, complete.totalTurns);
    }

    @Test
    public void lruEvictsSpoolsAndCloseDeletesRemainingFiles() throws Exception {
        Files.writeString(session, user("first"));
        index.read(reader, "fixture", null, 1, () -> true);
        Path firstSpool = index.spoolFiles().get(0);
        for (int number = 0; number < 3; number++) {
            String id = "other-" + number;
            Files.writeString(directory.resolve(id + ".jsonl"), user(id));
            index.read(reader, id, null, 1, () -> true);
        }
        assertEquals(2, index.size());
        assertFalse(Files.exists(firstSpool));
        var remaining = index.spoolFiles();
        index.close();
        assertEquals(0, index.size());
        assertTrue(remaining.stream().noneMatch(Files::exists));
    }

    @Test
    public void oversizedPendingMessageIsNotRetained() throws Exception {
        Files.writeString(session, user("large".repeat(1000)));
        try (var bounded = new CodexHistoryPageIndex(1, 10, 1000)) {
            var page = bounded.read(reader, "fixture", null, 1, () -> true);
            assertEquals(1, page.totalTurns);
            assertEquals(0, bounded.size());
        }
    }

    @Test
    public void messageAndDiskBudgetsFallBackWithoutDroppingHistory() throws Exception {
        Files.writeString(session, (user("question") + assistant("answer")).repeat(10));
        try (var bounded = new CodexHistoryPageIndex(1, 2, 4096)) {
            var page = bounded.read(reader, "fixture", 4, 2, () -> true);
            assertEquals(10, page.totalTurns);
            assertEquals(4, page.messages.size());
            assertEquals(0, bounded.size());
        }
        try (var bounded = new CodexHistoryPageIndex(1, 100, 32)) {
            var page = bounded.read(reader, "fixture", 4, 2, () -> true);
            assertEquals(10, page.totalTurns);
            assertEquals(4, page.messages.size());
            assertEquals(0, bounded.size());
        }
    }

    @Test
    public void indexedPagesMatchStreamingConversionIncludingMetadataAndMalformedLines() throws Exception {
        StringBuilder history = new StringBuilder("{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-fixture\",\"cwd\":\"/synthetic\"}}\n");
        for (int turn = 0; turn < 12; turn++) {
            history.append(user("question-" + turn).stripTrailing()).append(assistant("answer-" + turn));
            history.append("{invalid json\n\n");
        }
        Files.writeString(session, history);
        Integer[] cursors = {null, 0, 1, 5, 12, 100};
        for (Integer cursor : cursors) {
            var expected = HistoryMessageInjector.scanCodexHistoryPage(reader, "fixture", cursor, 3);
            var actual = index.read(reader, "fixture", cursor, 3, () -> true);
            assertEquals(expected.messages, actual.messages);
            assertEquals(expected.fromTurn, actual.fromTurn);
            assertEquals(expected.toTurn, actual.toTurn);
            assertEquals(expected.totalTurns, actual.totalTurns);
            assertEquals(expected.cursorReset, actual.cursorReset);
            assertEquals("thread-fixture", actual.threadId);
            assertEquals("/synthetic", actual.cwd);
        }
    }

    /** Equal-size overwrites must invalidate the cache on systems without a reliable change timestamp. */
    @Test
    public void sameInodeRewriteWithPreservedMtimeRebuildsIndex() throws Exception {
        Files.writeString(session, user("old"));
        index.read(reader, "fixture", null, 1, () -> true);
        var modified = Files.getLastModifiedTime(session);
        Files.writeString(session, user("new"));
        Files.setLastModifiedTime(session, modified);
        var page = index.read(reader, "fixture", null, 1, () -> true);
        assertEquals("new", page.messages.get(0).get("content").getAsString());
        assertEquals(1, page.rawRecordCount);
    }

    @Test
    public void replacementDuringScanDoesNotPublishMixedContents() throws Exception {
        Files.writeString(session, (user("question") + assistant("answer")).repeat(100));
        AtomicInteger checks = new AtomicInteger();
        assertThrows(java.io.IOException.class, () -> index.read(reader, "fixture", null, 30, () -> {
            if (checks.incrementAndGet() == 10) {
                try {
                    Files.writeString(session, user("replacement"));
                } catch (java.io.IOException exception) {
                    throw new java.io.UncheckedIOException(exception);
                }
            }
            return true;
        }));
        assertEquals(0, index.size());
        assertEquals("replacement", index.read(reader, "fixture", null, 1, () -> true).messages.get(0).get("content").getAsString());
    }

    @Test
    public void appendParsesOnlyNewRecordsAndTruncationResetsCursor() throws Exception {
        Files.writeString(session, user("first") + assistant("answer"));
        index.read(reader, "fixture", null, 1, () -> true);
        Files.writeString(session, user("second") + assistant("next"), StandardOpenOption.APPEND);
        var appended = index.read(reader, "fixture", null, 1, () -> true);
        assertEquals(2, appended.totalTurns);
        assertEquals(2, appended.rawRecordCount);
        Files.writeString(session, user("replacement"));
        var truncated = index.read(reader, "fixture", 2, 1, () -> true);
        assertTrue(truncated.cursorReset);
        assertEquals(1, truncated.totalTurns);
        assertEquals("replacement", truncated.messages.get(0).get("content").getAsString());
    }

    static String user(String text) {
        return "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"" + text + "\"}}\n";
    }

    static String assistant(String text) {
        return "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\","
                + "\"content\":[{\"type\":\"output_text\",\"text\":\"" + text + "\"}]}}\n";
    }
}

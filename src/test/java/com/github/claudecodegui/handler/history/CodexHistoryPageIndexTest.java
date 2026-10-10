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
    /** Keeps a pending known call visible without committing its preview into the page cache. */
    @Test
    public void pagedKnownCommandMatchesFullHistoryAfterItsTerminalOutputIsAppended() throws Exception {
        Files.writeString(this.session, user("inspect") + com.google.gson.JsonParser.parseString("""
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"known",
                "input":"text(await tools.exec_command({cmd:'npm test'}));"}}
                """) + "\n");
        var pending = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertTrue(pending.messages.toString(), pending.messages.toString().contains("bash"));
        assertFalse(pending.messages.toString().contains("tool_result"));
        assertEquals(HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class)), pending.messages);
        Files.writeString(this.session, com.google.gson.JsonParser.parseString("""
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"known",
                "output":[{"type":"input_text","text":"{\\"exit_code\\":0,\\"output\\":\\"passed\\"}"}]}}
                """) + "\n", StandardOpenOption.APPEND);
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        assertTrue(full.toString().contains("passed"));
    }
    /** Web extensions complete at EOF and indexed web strings survive appended history pages. */
    @Test
    public void pagedWebReceiptsMatchFullHistoryBeforeAndAfterOuterOutput() throws Exception {
        String call = """
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"web",
                "input":"text(await tools.web__run({open:[{ref_id:'https://example.com'}]}));"}}
                """;
        String receipt = """
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn",
                "item":{"type":"Extension","kind":"web.search","id":"web-item","query":"fixture","results":[]}}}
                """;
        Files.writeString(this.session, user("browse") + com.google.gson.JsonParser.parseString(call) + "\n"
                + com.google.gson.JsonParser.parseString(receipt) + "\n");
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(3, full.size());
        assertTrue(full.toString().contains("tool_result"));
        assertTrue(full.toString().contains("webSearch"));
        assertFalse(full.toString().contains("\"name\":\"exec\""));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        Files.writeString(this.session, com.google.gson.JsonParser.parseString("""
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"web",
                "output":"Script completed\\nOutput:\\ncomplete page body"}}
                """) + "\n" + assistant("done"), StandardOpenOption.APPEND);
        full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        assertTrue(full.toString().contains("complete page body"));
        try (var tiny = new CodexHistoryPageIndex(1, 1, 64)) {
            assertEquals(full, tiny.read(this.reader, "fixture", null, 30, () -> true).messages);
        }
    }

    /** Completed native receipts survive EOF and remain identical after append or cache-budget fallback. */
    @Test
    public void pagedNativeReceiptStaysCompletedBeforeTheOuterResultArrives() throws Exception {
        Files.writeString(this.session, user("inspect") + com.google.gson.JsonParser.parseString("""
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"known",
                "input":"text(await tools.exec_command({cmd:'npm test'}));"}}
                """) + "\n" + com.google.gson.JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn",
                "item":{"type":"CommandExecution","id":"native-command","status":"completed","exit_code":0,
                "command":["pwsh.exe","-Command","npm test"],"stdout":"passed"}}}
                """) + "\n");
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(3, full.size());
        assertTrue(full.toString().contains("tool_result"));
        assertFalse(full.toString().contains("\"name\":\"exec\""));
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
        try (var tiny = new CodexHistoryPageIndex(1, 1, 64)) {
            assertEquals(full, tiny.read(this.reader, "fixture", null, 30, () -> true).messages);
        }
        Files.writeString(this.session,
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"call_id\":\"known\",\"output\":\"Script completed\"}}\n"
                        + assistant("done"), StandardOpenOption.APPEND);
        full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(4, full.size());
        assertEquals(full, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
    }

    /** Keeps recorded dynamic patch cards identical in full reads and appended cached pages. */
    @Test
    public void pagedDynamicFileChangesMatchFullHistoryAfterAppend() throws Exception {
        String call = """
                {"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"dynamic",
                "input":"await tools.apply_patch(result.output);"}}
                """;
        String event = """
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn",
                "item":{"type":"FileChange","id":"stored-edit","status":"completed",
                "changes":{"a.ts":{"type":"add","content":"actual content\\n"}},"stdout":"applied","stderr":""}}}
                """;
        Files.writeString(this.session, user("inspect") + com.google.gson.JsonParser.parseString(call) + "\n"
                + com.google.gson.JsonParser.parseString(event) + "\n");
        var initial = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertTrue(initial.messages.toString().contains("file_change"));
        Files.writeString(this.session, """
                {"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"dynamic","output":"Script completed"}}
                """ + assistant("done"), StandardOpenOption.APPEND);
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        var page = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertEquals(full, page.messages);
        assertEquals(4, page.messages.size());
        assertEquals(page.messages, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
    }

    /** Uses the same patch and compaction projection for cached pages and full reads. */
    @Test
    public void pagedPatchesAndCompactionBoundariesMatchFullHistory() throws Exception {
        String patch = "*** Begin Patch\n*** Add File: a.ts\n+const a = 1;\n*** End Patch";
        var call = new com.google.gson.JsonObject();
        call.addProperty("type", "response_item");
        var payload = new com.google.gson.JsonObject();
        payload.addProperty("type", "custom_tool_call");
        payload.addProperty("call_id", "patch-wrapper");
        payload.addProperty("name", "exec");
        payload.addProperty("input", "text(await tools.apply_patch(" + new Gson().toJson(patch) + ")); ");
        call.add("payload", payload);
        Files.writeString(this.session, user("inspect") + call + "\n"
                + "{\"type\":\"compacted\",\"timestamp\":\"2026-10-02T10:30:00Z\",\"payload\":{\"message\":\"\"}}\n"
                + assistant("done"));
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        var page = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertEquals(full, page.messages);
        assertEquals(4, page.messages.size());
        assertTrue(page.messages.get(1).toString().contains("apply_patch"));
        assertTrue(page.messages.get(2).getAsJsonObject("raw").get("isCompactSummary").getAsBoolean());
        assertEquals(page.messages, this.index.read(this.reader, "fixture", null, 30, () -> true).messages);
    }
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

    @Test
    public void sameSizeTailRewriteWithRestoredMtimeRebuildsIndex() throws Exception {
        String prefix = user("prefix".repeat(2000));
        Files.writeString(session, prefix + user("old"));
        index.read(reader, "fixture", null, 1, () -> true);
        var modified = Files.getLastModifiedTime(session);
        Files.writeString(session, prefix + user("new"));
        Files.setLastModifiedTime(session, modified);

        var page = index.read(reader, "fixture", null, 1, () -> true);
        assertEquals("new", page.messages.get(0).get("content").getAsString());
        assertEquals(2, page.rawRecordCount);
        var repeated = index.read(reader, "fixture", null, 1, () -> true);
        assertEquals("new", repeated.messages.get(0).get("content").getAsString());
        assertEquals(0, repeated.rawRecordCount);
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

    @Test
    public void sameInodeRewriteWithPreservedMtimeInvalidatesOnUnix() throws Exception {
        org.junit.Assume.assumeTrue(session.getFileSystem().supportedFileAttributeViews().contains("unix"));
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

    /** Verifies the disk-backed page path keeps the same tools and thinking as full history. */
    @Test
    public void pagedHistoryRestoresExecCommandsReasoningAndHidesPageMetadata() throws Exception {
        String source = user("<external_codex_apps_open_page>{}</external_codex_apps_open_page>")
                + user("inspect")
                + "{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\",\"id\":\"r1\","
                + "\"summary\":[{\"type\":\"summary_text\",\"text\":\"Check the transport\"}],\"encrypted_content\":\"opaque\"}}\n"
                + "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"name\":\"exec\","
                + "\"call_id\":\"c1\",\"input\":\"text(await tools.exec_command({cmd:'git status',workdir:'D:/demo'}));\"}}\n"
                + "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\","
                + "\"call_id\":\"c1\",\"output\":\"On branch main\"}}\n" + assistant("done");
        Files.writeString(this.session, source);
        var page = this.index.read(this.reader, "fixture", null, 30, () -> true);
        assertEquals(1, page.totalTurns);
        assertEquals(5, page.messages.size());
        var thinking = page.messages.get(1).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("thinking", thinking.get("type").getAsString());
        assertEquals("Check the transport", thinking.get("thinking").getAsString());
        var tool = page.messages.get(2).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("git status", tool.getAsJsonObject("input").get("command").getAsString());
        assertTrue(page.messages.get(3).toString().contains("On branch main"));
        assertFalse(page.messages.toString().contains("open_page"));
        assertFalse(page.messages.toString().contains("opaque"));
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(full, page.messages);
    }

    /** Retains unreadable reasoning as a status boundary without exposing ciphertext or invented text. */
    @Test
    public void encryptedOnlyReasoningDoesNotBecomeTranscriptText() throws Exception {
        Files.writeString(this.session, user("inspect")
                + "{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\",\"encrypted_content\":\"cipher\"}}\n"
                + assistant("done"));
        var messages = this.index.read(this.reader, "fixture", null, 30, () -> true).messages;
        assertEquals(3, messages.size());
        var thinking = messages.get(1).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("thinking", thinking.get("type").getAsString());
        assertEquals("", thinking.get("thinking").getAsString());
        assertTrue(thinking.get("native").getAsBoolean());
        assertEquals("completed", thinking.get("status").getAsString());
        assertFalse(messages.toString().contains("cipher"));
        var full = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(new Gson().fromJson(
                this.reader.getSessionMessagesAsJson("fixture"), com.google.gson.JsonArray.class));
        assertEquals(full, messages);
    }

    static String assistant(String text) {
        return "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\","
                + "\"content\":[{\"type\":\"output_text\",\"text\":\"" + text + "\"}]}}\n";
    }
}

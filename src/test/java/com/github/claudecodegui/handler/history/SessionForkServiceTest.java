package com.github.claudecodegui.handler.history;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Coverage for the pure pieces of session forking: the per-row id rewrite and the
 * stream copy that materializes the fork file. The wider service needs a live
 * {@code ~/.claude/projects} tree and a Node bridge, so its orchestration is kept
 * thin and untested here, mirroring {@link SessionConversionServiceTest}.
 */
public class SessionForkServiceTest {

    private static final String SOURCE_ID = "11111111-2222-3333-4444-555555555555";
    private static final String FORK_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    // The tested paths (rewriteRowForFork, copySessionFile) touch neither the
    // HandlerContext nor the Node service caller, so nulls are fine.
    private final SessionForkService service = new SessionForkService(null, null);

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void rewriteRowReplacesTopLevelSessionId() {
        String row = "{\"uuid\":\"u1\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"user\"}";

        String out = SessionForkService.rewriteRowForFork(row, SOURCE_ID, FORK_ID);

        assertTrue(out.contains("\"sessionId\":\"" + FORK_ID + "\""));
        assertFalse(out.contains(SOURCE_ID));
        assertTrue(out.contains("\"uuid\":\"u1\""));
    }

    @Test
    public void rewriteRowReplacesAllOccurrencesIncludingNested() {
        String row = "{\"sessionId\":\"" + SOURCE_ID + "\",\"message\":{"
                + "\"role\":\"user\",\"content\":\"x\",\"sessionId\":\"" + SOURCE_ID + "\"}}";

        String out = SessionForkService.rewriteRowForFork(row, SOURCE_ID, FORK_ID);

        assertFalse(out.contains(SOURCE_ID));
        assertEquals(2, out.split("\"sessionId\":\"" + FORK_ID + "\"", -1).length - 1);
    }

    @Test
    public void rewriteRowKeepsUuidAndParentUuidChainsIntact() {
        String row = "{\"uuid\":\"u1\",\"parentUuid\":\"u0\",\"sessionId\":\"" + SOURCE_ID + "\"}";

        String out = SessionForkService.rewriteRowForFork(row, SOURCE_ID, FORK_ID);

        assertTrue(out.contains("\"uuid\":\"u1\""));
        assertTrue(out.contains("\"parentUuid\":\"u0\""));
    }

    @Test
    public void rewriteRowTouchesOnlyExactSourceId() {
        // An agent row may carry its own thread id under a same-named field; that value
        // must survive the fork untouched.
        String row = "{\"sessionId\":\"agent-thread-1\",\"parentSessionId\":\"" + SOURCE_ID + "\"}";

        String out = SessionForkService.rewriteRowForFork(row, SOURCE_ID, FORK_ID);

        assertTrue(out.contains("\"sessionId\":\"agent-thread-1\""));
        assertTrue(out.contains("\"parentSessionId\":\"" + FORK_ID + "\""));
    }

    @Test
    public void rewriteRowDoesNotMatchSimilarFieldNames() {
        String row = "{\"entrySessionId\":\"" + SOURCE_ID + "\",\"sessionIdX\":\"" + SOURCE_ID + "\"}";

        String out = SessionForkService.rewriteRowForFork(row, SOURCE_ID, FORK_ID);

        // Neither field is actually named sessionId/parentSessionId, so nothing changes.
        assertEquals(row, out);
    }

    @Test
    public void rewriteRowKeepsNonJsonRowUnchanged() {
        String line = "this is not json";

        assertEquals(line, SessionForkService.rewriteRowForFork(line, SOURCE_ID, FORK_ID));
    }

    @Test
    public void rewriteRowLeavesRowsWithoutIdsUnchanged() {
        String row = "{\"type\":\"summary\",\"title\":\"hello\"}";

        assertEquals(row, SessionForkService.rewriteRowForFork(row, SOURCE_ID, FORK_ID));
    }

    @Test
    public void copySessionFileCreatesIndependentForkWithRewrittenIds() throws IOException {
        Path dir = temporaryFolder.newFolder("project").toPath();
        Path source = dir.resolve(SOURCE_ID + ".jsonl");
        Files.write(source, List.of(
                "{\"uuid\":\"u1\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"user\"}",
                "torn line without trailing newline content",
                "{\"uuid\":\"u2\",\"parentUuid\":\"u1\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"assistant\"}"
        ), StandardCharsets.UTF_8);

        Path target = dir.resolve(FORK_ID + ".jsonl");
        service.copySessionFile(source, target, SOURCE_ID, FORK_ID, null);

        assertTrue(Files.exists(target));
        assertFalse("temp files must be cleaned up after the move",
                Files.exists(dir.resolve(FORK_ID + ".jsonl.fork")));

        List<String> forkedRows = Files.readAllLines(target, StandardCharsets.UTF_8);
        assertEquals(3, forkedRows.size());
        assertFalse(forkedRows.get(0).contains(SOURCE_ID));
        assertTrue(forkedRows.get(0).contains("\"sessionId\":\"" + FORK_ID + "\""));
        assertTrue(forkedRows.get(1).startsWith("torn line without trailing newline content"));
        assertTrue(forkedRows.get(2).contains("\"parentUuid\":\"u1\""));

        // Source is read-only: untouched by the fork.
        List<String> sourceRows = Files.readAllLines(source, StandardCharsets.UTF_8);
        assertEquals(3, sourceRows.size());
        assertTrue(sourceRows.get(0).contains(SOURCE_ID));
    }

    @Test
    public void copySessionFileRewritesParentSessionIdOnAgentRows() throws IOException {
        Path dir = temporaryFolder.newFolder("agents").toPath();
        Path source = dir.resolve("agent-777.jsonl");
        Files.write(source, List.of(
                "{\"agentId\":\"a1\",\"sessionId\":\"" + SOURCE_ID + "\"}",
                "{\"agentId\":\"a2\",\"parentSessionId\":\"" + SOURCE_ID + "\"}"
        ), StandardCharsets.UTF_8);

        Path target = dir.resolve("agent-888.jsonl");
        service.copySessionFile(source, target, SOURCE_ID, FORK_ID, null);

        String joined = Files.readAllLines(target, StandardCharsets.UTF_8).stream()
                .collect(Collectors.joining("\n"));
        assertTrue(joined.contains("\"sessionId\":\"" + FORK_ID + "\""));
        assertTrue(joined.contains("\"parentSessionId\":\"" + FORK_ID + "\""));
        assertFalse(joined.contains(SOURCE_ID));
    }

    // ── fork-at-message turn boundary ──────────────────────────────────────────

    private static final String A1 = "uuuuuuuu-aaaa-1111-1111-111111111111";
    private static final String A2 = "uuuuuuuu-aaaa-2222-2222-222222222222";
    private static final String U1 = "uuuuuuuu-bbbb-1111-1111-111111111111";
    private static final String U2 = "uuuuuuuu-bbbb-2222-2222-222222222222";
    private static final String U3 = "uuuuuuuu-bbbb-3333-3333-333333333333";

    /**
     * turn 1: user U1 → assistant A1 (tool_use) → user(tool_result) → assistant A2 (final text)
     * turn 2: user U2 (real text) → assistant A3...
     */
    private List<String> turnFixture() {
        return List.of(
                "{\"uuid\":\"" + U1 + "\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"user\","
                        + "\"message\":{\"role\":\"user\",\"content\":\"hello\"}}",
                "{\"uuid\":\"" + A1 + "\",\"parentUuid\":\"" + U1 + "\",\"sessionId\":\"" + SOURCE_ID + "\","
                        + "\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":"
                        + "[{\"type\":\"tool_use\",\"id\":\"t1\"}]}}",
                "{\"uuid\":\"" + U2 + "\",\"parentUuid\":\"" + A1 + "\",\"sessionId\":\"" + SOURCE_ID + "\","
                        + "\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":"
                        + "[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\"}]}}",
                "{\"uuid\":\"" + A2 + "\",\"parentUuid\":\"" + U2 + "\",\"sessionId\":\"" + SOURCE_ID + "\","
                        + "\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":"
                        + "[{\"type\":\"text\",\"text\":\"done\"}]}}",
                "{\"uuid\":\"" + U3 + "\",\"parentUuid\":\"" + A2 + "\",\"sessionId\":\"" + SOURCE_ID + "\","
                        + "\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"next question\"}}",
                "{\"uuid\":\"uuuuuuuu-aaaa-3333-3333-333333333333\",\"parentUuid\":\"" + U3 + "\","
                        + "\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"assistant\","
                        + "\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"answer\"}]}}"
        );
    }

    private Path writeFixture(List<String> rows) throws IOException {
        Path dir = temporaryFolder.newFolder("cut-" + System.nanoTime()).toPath();
        Path source = dir.resolve(SOURCE_ID + ".jsonl");
        Files.write(source, rows, StandardCharsets.UTF_8);
        return source;
    }

    @Test
    public void cutIndexForFirstAssistantIncludesWholeToolCycle() throws IOException {
        Path source = writeFixture(turnFixture());

        // Clicking assistant A1 (the tool_use row) must keep the tool_result row and the
        // final A2 text row of the same turn, and cut before the next real user message.
        int cut = SessionForkService.resolveCutIndex(source, A1);

        assertEquals(4, cut);
    }

    @Test
    public void cutIndexForLastAssistantCopiesEverything() throws IOException {
        Path source = writeFixture(turnFixture());

        int cut = SessionForkService.resolveCutIndex(source,
                "uuuuuuuu-aaaa-3333-3333-333333333333");

        assertEquals(6, cut);
    }

    @Test
    public void cutIndexForUnknownUuidIsNegative() throws IOException {
        Path source = writeFixture(turnFixture());

        assertEquals(-1, SessionForkService.resolveCutIndex(source, "ffffffff-0000-0000-0000-000000000000"));
    }

    @Test
    public void copySessionFileAtForkPointTruncatesAndRewrites() throws IOException {
        Path source = writeFixture(turnFixture());
        Path target = source.getParent().resolve(FORK_ID + ".jsonl");

        service.copySessionFile(source, target, SOURCE_ID, FORK_ID, A1);

        List<String> rows = Files.readAllLines(target, StandardCharsets.UTF_8);
        // Rows U1, A1, tool_result, A2 — the whole turn, nothing from turn 2.
        assertEquals(4, rows.size());
        assertFalse(rows.get(3).contains(U3));
        assertTrue(rows.get(0).contains("\"sessionId\":\"" + FORK_ID + "\""));
        assertTrue(rows.get(1).contains("\"uuid\":\"" + A1 + "\""));
        assertTrue(rows.get(1).contains("\"parentUuid\":\"" + U1 + "\""));

        // Source untouched.
        assertEquals(6, Files.readAllLines(source, StandardCharsets.UTF_8).size());
    }

    @Test
    public void copySessionFileWithUnknownForkPointFailsWithoutCreatingTarget() throws IOException {
        Path source = writeFixture(turnFixture());
        Path target = source.getParent().resolve(FORK_ID + ".jsonl");

        try {
            service.copySessionFile(source, target, SOURCE_ID, FORK_ID, "ffffffff-0000-0000-0000-000000000000");
            throw new AssertionError("expected ForkPointNotFoundException");
        } catch (SessionForkService.ForkPointNotFoundException e) {
            // expected
        }
        assertFalse(Files.exists(target));
        assertFalse(Files.exists(source.getParent().resolve(FORK_ID + ".jsonl.fork")));
    }

    @Test
    public void realUserTextRowDetectionSkipsToolResultAndMetaRows() {
        assertTrue(SessionForkService.isRealUserTextRow(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}"));
        assertTrue(SessionForkService.isRealUserTextRow(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}"));
        assertFalse(SessionForkService.isRealUserTextRow(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"[tool_result]\"}}"));
        assertFalse(SessionForkService.isRealUserTextRow(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\"}]}}"));
        assertFalse(SessionForkService.isRealUserTextRow(
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"meta\"}}"));
        assertFalse(SessionForkService.isRealUserTextRow(
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[]}}"));
        assertFalse(SessionForkService.isRealUserTextRow("not json at all"));
    }
}

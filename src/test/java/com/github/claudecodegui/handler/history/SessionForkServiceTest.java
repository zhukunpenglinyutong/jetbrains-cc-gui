package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.NodeJsServiceCaller;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Coverage for session forking: the pure pieces (per-row id rewrite, the stream
 * copy that materializes the fork file) and the orchestration — payload
 * validation, error routing, the temp-home file scan, and the best-effort title
 * application — against a temporary {@code ~/.claude} tree with a fake bridge.
 */
public class SessionForkServiceTest {

    private static final String SOURCE_ID = "11111111-2222-3333-4444-555555555555";
    private static final String FORK_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    // The pure paths (rewriteRowForFork, copySessionFile) touch neither the
    // HandlerContext nor the Node service caller, so nulls are fine.
    private final SessionForkService service = new SessionForkService(null, null);

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    private Application previousApplication;

    /** Run fork work synchronously; forkSession dispatches on the pooled thread. */
    @Before
    public void runPooledTasksInline() {
        previousApplication = ApplicationManager.getApplication();
        Application application = (Application) Proxy.newProxyInstance(Application.class.getClassLoader(),
                new Class<?>[]{Application.class}, (proxy, method, arguments) -> {
                    if ("executeOnPooledThread".equals(method.getName())) {
                        ((Runnable) arguments[0]).run();
                        return CompletableFuture.completedFuture(null);
                    }
                    if (method.getReturnType() == boolean.class) {
                        return false;
                    }
                    return null;
                });
        ApplicationManager.setApplication(application);
    }

    @After
    public void restoreApplication() {
        ApplicationManager.setApplication(previousApplication);
    }

    /** Records the window.onForkResult scripts the service queues. */
    private static final class RecordingJsCallback implements HandlerContext.JsCallback {
        final List<String> scripts = new ArrayList<>();

        @Override
        public void callJavaScript(String functionName, String... args) {
        }

        @Override
        public String escapeJs(String str) {
            return str;
        }

        @Override
        public void executeJavaScript(String jsCode) {
            scripts.add(jsCode);
        }
    }

    /** One title-service reply, recorded instead of spawned. */
    private static final class RecordingTitleCaller extends NodeJsServiceCaller {
        final List<String> titles = new ArrayList<>();
        String nextReply = "{\"success\":true}";

        RecordingTitleCaller() {
            super(null);
        }

        @Override
        public String callNodeJsTitlesServiceWithParams(String functionName, String sessionId,
                                                        String customTitle) {
            titles.add(customTitle);
            return nextReply;
        }
    }

    /** A live-enough Project stub: sendForkResult only queues scripts for one. */
    private static Project stubProject() {
        return (Project) Proxy.newProxyInstance(Project.class.getClassLoader(),
                new Class<?>[]{Project.class}, (proxy, method, arguments) -> {
                    if ("isDisposed".equals(method.getName())) {
                        return false;
                    }
                    if (method.getReturnType() == boolean.class) {
                        return false;
                    }
                    return null;
                });
    }

    /** Extract the JSON payload of the (only) queued window.onForkResult call. */
    private static String forkResultJson(RecordingJsCallback callback) {
        assertEquals(1, callback.scripts.size());
        Matcher matcher = Pattern.compile("window\\.onForkResult\\('(.*?)'\\)").matcher(callback.scripts.get(0));
        assertTrue("expected a queued onForkResult script: " + callback.scripts, matcher.find());
        return matcher.group(1);
    }

    private Path claudeHomeRoot;

    /** The temp {@code ~/.claude/projects} tree; one home per test, idempotent. */
    private Path newClaudeHome() throws IOException {
        if (claudeHomeRoot == null) {
            claudeHomeRoot = temporaryFolder.newFolder("claude-home").toPath();
        }
        return Files.createDirectories(claudeHomeRoot.resolve(".claude").resolve("projects"));
    }

    private Path claudeHomeRoot() throws IOException {
        newClaudeHome();
        return claudeHomeRoot;
    }

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
        assertNoTempFiles(dir);

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
    public void cutIndexSkipsRowsThatEmbedTheAnchorNeedleInsideTheirContent() throws IOException {
        // A row echoing a transcript fragment (a tool that re-reads the transcript
        // embeds whole JSON rows) carries the anchor needle inside its content.
        // Anchoring there instead of the real assistant row would fork from the
        // wrong turn, so the candidate must be verified against the parsed uuid.
        List<String> rows = new java.util.ArrayList<>(turnFixture());
        rows.add(5, "{\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"system\","
                + "\"content\":\"row echo\","
                + "\"row\":{\"uuid\":\"" + A1 + "\",\"type\":\"assistant\"}}");

        Path source = writeFixture(rows);

        assertEquals(4, SessionForkService.resolveCutIndex(source, A1));
    }

    @Test
    public void cutIndexToleratesAMalformedRowContainingTheAnchorNeedle() throws IOException {
        // A truncated row can still contain the literal needle: the containment
        // pre-check hits it, the parse fails, and the scan must skip the row
        // instead of crashing the fork.
        List<String> rows = new java.util.ArrayList<>();
        rows.add("{\"uuid\":\"" + A1 + "\",\"sessionId");
        rows.addAll(turnFixture());

        Path source = writeFixture(rows);

        // The malformed row is skipped and the real anchor (index 2) wins; the
        // whole tool cycle after it still fits.
        assertEquals(5, SessionForkService.resolveCutIndex(source, A1));
    }

    /**
     * An interrupted turn between the anchor and the next real user row carries
     * a tool call that never received its result: keeping it would end the fork
     * mid-call and the API would reject the resume, so the cut shrinks back to
     * the first assistant row of the incomplete cycle.
     */
    @Test
    public void cutIndexShrinksPastAnInterruptedToolCycle() throws IOException {
        List<String> rows = List.of(
                "{\"uuid\":\"" + U1 + "\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"user\","
                        + "\"message\":{\"role\":\"user\",\"content\":\"hello\"}}",
                "{\"uuid\":\"" + A1 + "\",\"parentUuid\":\"" + U1 + "\",\"sessionId\":\"" + SOURCE_ID + "\","
                        + "\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":"
                        + "[{\"type\":\"text\",\"text\":\"answered\"}]}}",
                "{\"uuid\":\"" + A2 + "\",\"parentUuid\":\"" + A1 + "\",\"sessionId\":\"" + SOURCE_ID + "\","
                        + "\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":"
                        + "[{\"type\":\"tool_use\",\"id\":\"t9\"}]}}",
                "{\"uuid\":\"" + U2 + "\",\"parentUuid\":\"" + A2 + "\",\"sessionId\":\"" + SOURCE_ID + "\","
                        + "\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"next question\"}}"
        );

        Path source = writeFixture(rows);

        // Forking from A1 keeps only turn 1's completed reply; the interrupted
        // A2 cycle is cut out instead of leaving a dangling tool_use.
        assertEquals(2, SessionForkService.resolveCutIndex(source, A1));
    }

    @Test
    public void cutIndexDropsAnInterruptedTailCycleAtEof() throws IOException {
        // Same hazard at end of file: the transcript ends mid-cycle, so the
        // "keep the rest" default would end the fork on an open tool call.
        List<String> rows = List.of(
                "{\"uuid\":\"" + U1 + "\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"user\","
                        + "\"message\":{\"role\":\"user\",\"content\":\"hello\"}}",
                "{\"uuid\":\"" + A1 + "\",\"parentUuid\":\"" + U1 + "\",\"sessionId\":\"" + SOURCE_ID + "\","
                        + "\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":"
                        + "[{\"type\":\"text\",\"text\":\"answered\"}]}}",
                "{\"uuid\":\"" + A2 + "\",\"parentUuid\":\"" + A1 + "\",\"sessionId\":\"" + SOURCE_ID + "\","
                        + "\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":"
                        + "[{\"type\":\"tool_use\",\"id\":\"t9\"}]}}"
        );

        Path source = writeFixture(rows);

        assertEquals(2, SessionForkService.resolveCutIndex(source, A1));
    }

    @Test
    public void cutIndexRejectsAnAnchorTurnWithAnUnresolvedToolCall() throws IOException {
        // The clicked reply's own cycle is interrupted: no cut keeps the reply
        // while dropping the call, so the fork is refused outright.
        List<String> rows = List.of(
                "{\"uuid\":\"" + U1 + "\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"user\","
                        + "\"message\":{\"role\":\"user\",\"content\":\"hello\"}}",
                "{\"uuid\":\"" + A1 + "\",\"parentUuid\":\"" + U1 + "\",\"sessionId\":\"" + SOURCE_ID + "\","
                        + "\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":"
                        + "[{\"type\":\"tool_use\",\"id\":\"t9\"}]}}"
        );

        Path source = writeFixture(rows);

        try {
            SessionForkService.resolveCutIndex(source, A1);
            throw new AssertionError("expected DanglingToolUseException");
        } catch (SessionForkService.DanglingToolUseException e) {
            // expected
        }
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
        assertNoTempFiles(source.getParent());
    }

    @Test
    public void copySessionFileWritesLfLineEndings() throws IOException {
        Path dir = temporaryFolder.newFolder("eol").toPath();
        Path source = dir.resolve(SOURCE_ID + ".jsonl");
        Files.write(source, List.of(
                "{\"sessionId\":\"" + SOURCE_ID + "\"}",
                "{\"type\":\"user\"}"
        ), StandardCharsets.UTF_8);

        Path target = dir.resolve(FORK_ID + ".jsonl");
        service.copySessionFile(source, target, SOURCE_ID, FORK_ID, null);

        String raw = new String(Files.readAllBytes(target), StandardCharsets.UTF_8);
        assertFalse("the fork must keep the CLI's LF endings", raw.contains("\r"));
    }

    @Test
    public void copySessionFileDropsATornTailRow() throws IOException {
        // A fork file must never end on a torn row: the full-history reader
        // reports such a copy incomplete forever, because nothing ever appends
        // behind the row. The torn row is dropped; complete rows are copied.
        Path dir = temporaryFolder.newFolder("torn-tail").toPath();
        Path source = dir.resolve(SOURCE_ID + ".jsonl");
        // No trailing newline: the last row is torn mid-JSON, exactly what the
        // CLI leaves behind while it is still appending.
        Files.write(source, String.join("\n",
                "{\"uuid\":\"u1\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"user\"}",
                "{\"uuid\":\"u2\",\"parentUuid\":\"u1\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"assistant\"}",
                "{\"uuid\":\"u3\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"assi")
                .getBytes(StandardCharsets.UTF_8));

        Path target = dir.resolve(FORK_ID + ".jsonl");
        service.copySessionFile(source, target, SOURCE_ID, FORK_ID, null);

        List<String> rows = Files.readAllLines(target, StandardCharsets.UTF_8);
        assertEquals(2, rows.size());
        assertTrue(rows.get(1).contains("\"uuid\":\"u2\""));
    }

    @Test
    public void copySessionFileKeepsAMidFileNonJsonRowVerbatim() throws IOException {
        // Mid-file non-JSON rows are stale damage the reader tolerates: they
        // stay verbatim. Only the terminal row is validated.
        Path dir = temporaryFolder.newFolder("mid-file-torn").toPath();
        Path source = dir.resolve(SOURCE_ID + ".jsonl");
        Files.write(source, List.of(
                "{\"sessionId\":\"" + SOURCE_ID + "\"}",
                "not json at all",
                "{\"type\":\"user\"}"
        ), StandardCharsets.UTF_8);

        Path target = dir.resolve(FORK_ID + ".jsonl");
        service.copySessionFile(source, target, SOURCE_ID, FORK_ID, null);

        List<String> rows = Files.readAllLines(target, StandardCharsets.UTF_8);
        assertEquals(3, rows.size());
        assertEquals("not json at all", rows.get(1));
    }

    @Test
    public void copySessionFileFailsWhenEveryRowOfANonEmptySourceIsDropped() throws IOException {
        // A transcript that is only a torn row cannot yield a usable fork: an
        // empty copy would look like a blank session, so the fork fails.
        Path dir = temporaryFolder.newFolder("all-torn").toPath();
        Path source = dir.resolve(SOURCE_ID + ".jsonl");
        Files.write(source, "{\"uuid\":\"u1\",\"session".getBytes(StandardCharsets.UTF_8));

        Path target = dir.resolve(FORK_ID + ".jsonl");

        try {
            service.copySessionFile(source, target, SOURCE_ID, FORK_ID, null);
            throw new AssertionError("expected an IOException for a fully dropped copy");
        } catch (IOException expected) {
            // expected
        }
        assertFalse(Files.exists(target));
        assertNoTempFiles(dir);
    }

    // ── sidechain copy ─────────────────────────────────────────────────────────

    /** Current layout: {@code <project>/<sessionId>/subagents/**} copied under the fork id. */
    @Test
    public void copySidechainsMirrorsTheCurrentLayoutUnderTheForkId() throws IOException {
        Path projectDir = temporaryFolder.newFolder("sidechains").toPath();
        Path subagents = Files.createDirectories(projectDir.resolve(SOURCE_ID).resolve("subagents"));
        Path nested = Files.createDirectories(subagents.resolve("nested"));
        Files.write(subagents.resolve("agent-a1.jsonl"), List.of(
                        "{\"uuid\":\"s1\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"assistant\"}"),
                StandardCharsets.UTF_8);
        Files.write(subagents.resolve("agent-a1.meta.json"),
                "{\"agentId\":\"a1\"}".getBytes(StandardCharsets.UTF_8));
        Files.write(nested.resolve("agent-a2.jsonl"), List.of(
                        "{\"uuid\":\"s2\",\"parentSessionId\":\"" + SOURCE_ID + "\",\"type\":\"assistant\"}"),
                StandardCharsets.UTF_8);

        service.copySidechains(projectDir, SOURCE_ID, FORK_ID);

        Path forkSubagents = projectDir.resolve(FORK_ID).resolve("subagents");
        String transcript = Files.readString(forkSubagents.resolve("agent-a1.jsonl"), StandardCharsets.UTF_8);
        assertTrue(transcript.contains("\"sessionId\":\"" + FORK_ID + "\""));
        assertFalse(transcript.contains(SOURCE_ID));
        // Non-JSONL sidecars are copied verbatim, not parsed.
        assertEquals("{\"agentId\":\"a1\"}",
                Files.readString(forkSubagents.resolve("agent-a1.meta.json"), StandardCharsets.UTF_8));
        // Nested levels come along: a missed level would leave the fork's subagent
        // panel half-empty while the copy still looked successful.
        assertTrue(Files.readString(forkSubagents.resolve("nested/agent-a2.jsonl"), StandardCharsets.UTF_8)
                .contains("\"parentSessionId\":\"" + FORK_ID + "\""));
    }

    @Test
    public void copySidechainsIgnoresForeignEntriesBesideTheSubagentsDirectory() throws IOException {
        // The delete path removes only the known subagents subtree; copying anything
        // else would leave fork directories it can never fully clean up.
        Path projectDir = temporaryFolder.newFolder("sidechain-foreign").toPath();
        Path subagents = Files.createDirectories(projectDir.resolve(SOURCE_ID).resolve("subagents"));
        Files.write(subagents.resolve("agent-a1.jsonl"), List.of(
                        "{\"uuid\":\"s1\",\"sessionId\":\"" + SOURCE_ID + "\"}"),
                StandardCharsets.UTF_8);
        Files.write(projectDir.resolve(SOURCE_ID).resolve("foreign.json"), List.of("keep out"),
                StandardCharsets.UTF_8);

        service.copySidechains(projectDir, SOURCE_ID, FORK_ID);

        assertFalse(Files.exists(projectDir.resolve(FORK_ID).resolve("foreign.json")));
        assertTrue(Files.exists(projectDir.resolve(FORK_ID).resolve("subagents").resolve("agent-a1.jsonl")));
    }

    /**
     * Symbolic links inside subagents/ are skipped: following them could copy
     * content from outside the source tree, and a directory loop would recurse
     * until StackOverflowError escaped the per-entry catch.
     */
    @Test
    public void copySidechainsSkipsSymbolicLinks() throws IOException {
        Path projectDir = temporaryFolder.newFolder("sidechain-links").toPath();
        Path outsideDir = temporaryFolder.newFolder("outside").toPath();
        Path subagents = Files.createDirectories(projectDir.resolve(SOURCE_ID).resolve("subagents"));
        Files.write(subagents.resolve("agent-a1.jsonl"), List.of(
                        "{\"uuid\":\"s1\",\"sessionId\":\"" + SOURCE_ID + "\"}"),
                StandardCharsets.UTF_8);
        Files.write(outsideDir.resolve("secret.json"), List.of("outside content"),
                StandardCharsets.UTF_8);
        Files.createSymbolicLink(subagents.resolve("outside-file"),
                outsideDir.resolve("secret.json"));
        Files.createSymbolicLink(subagents.resolve("outside-dir"), outsideDir);

        service.copySidechains(projectDir, SOURCE_ID, FORK_ID);

        Path forkSubagents = projectDir.resolve(FORK_ID).resolve("subagents");
        assertTrue(Files.exists(forkSubagents.resolve("agent-a1.jsonl")));
        assertFalse("a file link must not drag in outside content",
                Files.exists(forkSubagents.resolve("outside-file")));
        assertFalse("a directory link must not be recursed into",
                Files.exists(forkSubagents.resolve("outside-dir")));
    }

    /** Legacy layout: flat {@code agent-*.jsonl} referencing the session, copied under a fresh name. */
    @Test
    public void copySidechainsCopiesLegacyAgentFilesUnderFreshNames() throws IOException {
        Path projectDir = temporaryFolder.newFolder("legacy-agents").toPath();
        Files.write(projectDir.resolve("agent-owned.jsonl"), List.of(
                        "{\"uuid\":\"l1\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"assistant\"}"),
                StandardCharsets.UTF_8);
        Files.write(projectDir.resolve("agent-foreign.jsonl"), List.of(
                        "{\"uuid\":\"f1\",\"sessionId\":\"99999999-9999-9999-9999-999999999999\"}"),
                StandardCharsets.UTF_8);

        service.copySidechains(projectDir, SOURCE_ID, FORK_ID);

        List<Path> agentFiles;
        try (Stream<Path> entries = Files.list(projectDir)) {
            agentFiles = entries
                    .filter(path -> path.getFileName().toString().startsWith("agent-"))
                    .collect(Collectors.toList());
        }
        // Two originals plus exactly one copy.
        assertEquals(3, agentFiles.size());

        List<Path> copies = agentFiles.stream()
                .filter(path -> !path.getFileName().toString().equals("agent-owned.jsonl")
                        && !path.getFileName().toString().equals("agent-foreign.jsonl"))
                .collect(Collectors.toList());
        assertEquals(1, copies.size());
        String copied = Files.readString(copies.get(0), StandardCharsets.UTF_8);
        assertTrue(copied.contains("\"sessionId\":\"" + FORK_ID + "\""));
        assertFalse(copied.contains(SOURCE_ID));
        // The unrelated transcript is not dragged along.
        assertTrue(Files.readString(projectDir.resolve("agent-foreign.jsonl"), StandardCharsets.UTF_8)
                .contains("99999999-9999-9999-9999-999999999999"));
    }

    /**
     * The whole point of copying the sidechains: deleting one session's sidecars must
     * not touch the other's. Guards the pair of trees the delete path now relies on.
     */
    @Test
    public void deletingTheForkSidechainsLeavesTheSourceIntact() throws IOException {
        Path projectDir = temporaryFolder.newFolder("independent").toPath();
        Path subagents = Files.createDirectories(projectDir.resolve(SOURCE_ID).resolve("subagents"));
        Files.write(subagents.resolve("agent-a1.jsonl"), List.of(
                        "{\"uuid\":\"s1\",\"sessionId\":\"" + SOURCE_ID + "\"}"),
                StandardCharsets.UTF_8);

        service.copySidechains(projectDir, SOURCE_ID, FORK_ID);
        deleteRecursively(projectDir.resolve(FORK_ID));

        assertFalse(Files.exists(projectDir.resolve(FORK_ID)));
        assertTrue(Files.exists(subagents.resolve("agent-a1.jsonl")));
        assertTrue(Files.readString(subagents.resolve("agent-a1.jsonl"), StandardCharsets.UTF_8)
                .contains(SOURCE_ID));
    }

    private static void deleteRecursively(Path root) throws IOException {
        try (Stream<Path> paths = Files.walk(root)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).collect(Collectors.toList())) {
                Files.delete(path);
            }
        }
    }

    /** Temp files are named {@code <id>.jsonl.fork.<random>.tmp}; assert none survive. */
    private static void assertNoTempFiles(Path dir) throws IOException {
        try (Stream<Path> entries = Files.list(dir)) {
            assertFalse("temp files must be cleaned up",
                    entries.anyMatch(path -> path.getFileName().toString().endsWith(".tmp")));
        }
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

    /**
     * Row classification must match {@code HistoryMessageInjector.isHumanUserMessage}:
     * image-only rows and rows mixing tool results with genuine input both start a
     * user turn, so a fork anchored before them must not swallow their turns.
     */
    @Test
    public void realUserTextRowCountsImageAndMixedRowsAsUserTurns() {
        // Image-only input is a real user turn.
        assertTrue(SessionForkService.isRealUserTextRow(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":"
                        + "[{\"type\":\"image\",\"source\":{\"type\":\"base64\"}}]}}"));
        // Tool results alongside genuine text do not disqualify the row.
        assertTrue(SessionForkService.isRealUserTextRow(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":"
                        + "[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\"},{\"type\":\"text\",\"text\":\"and also this\"}]}}"));
        // A tool-result-only row stays inside the assistant cycle.
        assertFalse(SessionForkService.isRealUserTextRow(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":"
                        + "[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\"}]}}"));
    }

    @Test
    public void truncateForkTitleCutsByCodeUnitsWithoutSplittingSurrogatePairs() {
        assertNull(SessionForkService.truncateForkTitle(null));
        assertEquals("short", SessionForkService.truncateForkTitle("short"));
        // Exactly at the limit: untouched.
        assertEquals("x".repeat(SessionForkService.MAX_TITLE_LENGTH),
                SessionForkService.truncateForkTitle("x".repeat(SessionForkService.MAX_TITLE_LENGTH)));

        // 49 units + one emoji pair: the cut would split the pair, so it backs off
        // to 49 and drops the emoji entirely instead of persisting half of it.
        String emojiAtCut = "x".repeat(SessionForkService.MAX_TITLE_LENGTH - 1) + "😀";
        String truncated = SessionForkService.truncateForkTitle(emojiAtCut);
        assertEquals(SessionForkService.MAX_TITLE_LENGTH - 1, truncated.length());
        assertFalse(truncated.contains("😀"));

        // The pair already inside the window survives intact; the trailing unit is
        // dropped because the pair occupies the last two slots of the window.
        String emojiInside = "x".repeat(SessionForkService.MAX_TITLE_LENGTH - 2) + "😀y";
        String kept = SessionForkService.truncateForkTitle(emojiInside);
        assertEquals(SessionForkService.MAX_TITLE_LENGTH, kept.length());
        assertTrue(kept.contains("😀"));
        assertFalse("the pair must survive complete",
                Character.isHighSurrogate(kept.charAt(kept.length() - 1)));
    }

    @Test
    public void forkSessionRejectsAnUnparseablePayloadWithTheGenericCode() {
        RecordingJsCallback callback = new RecordingJsCallback();
        SessionForkService forkService = new SessionForkService(
                new HandlerContext(stubProject(), null, null, null, callback), null);

        forkService.forkSession("{not json", null);

        assertEquals("FORK_FAILED", forkResultCode(callback));
    }

    @Test
    public void forkSessionRejectsAnInvalidSessionId() {
        RecordingJsCallback callback = new RecordingJsCallback();
        SessionForkService forkService = new SessionForkService(
                new HandlerContext(stubProject(), null, null, null, callback), null);

        forkService.forkSession("{\"sessionId\":\"../escape\"}", null);

        assertEquals("INVALID_SESSION_ID", forkResultCode(callback));
    }

    @Test
    public void forkSessionRejectsAnInvalidForkPointUuid() {
        RecordingJsCallback callback = new RecordingJsCallback();
        SessionForkService forkService = new SessionForkService(
                new HandlerContext(stubProject(), null, null, null, callback), null);

        forkService.forkSession("{\"sessionId\":\"" + SOURCE_ID + "\",\"forkPointUuid\":\"a/b\"}", null);

        assertEquals("INVALID_SESSION_ID", forkResultCode(callback));
    }

    @Test
    public void forkSessionRejectsAnUnsupportedProvider() {
        RecordingJsCallback callback = new RecordingJsCallback();
        SessionForkService forkService = new SessionForkService(
                new HandlerContext(stubProject(), null, null, null, callback), null);

        forkService.forkSession("{\"sessionId\":\"" + SOURCE_ID + "\",\"provider\":\"codex\"}", null);

        assertEquals("UNSUPPORTED_PROVIDER", forkResultCode(callback));
    }

    @Test
    public void forkSessionReportsAMissingSession() throws IOException {
        RecordingJsCallback callback = new RecordingJsCallback();
        SessionForkService forkService = new SessionForkService(
                new HandlerContext(stubProject(), null, null, null, callback), null);

        forkService.forkSession("{\"sessionId\":\"" + SOURCE_ID + "\"}", null,
                claudeHomeRoot());

        assertEquals("SESSION_NOT_FOUND", forkResultCode(callback));
    }

    @Test
    public void forkSessionReportsAnUnreadableProjectsDirectoryAsForkFailed() throws Exception {
        // A permissions problem must not masquerade as "session not found": the
        // finder now propagates IO errors and the caller routes them to FORK_FAILED.
        Path claudeHome = newClaudeHome();
        java.util.Set<java.nio.file.attribute.PosixFilePermission> restore =
                Files.getPosixFilePermissions(claudeHome);
        Files.setPosixFilePermissions(claudeHome, PosixFilePermissions.fromString("---------"));
        RecordingJsCallback callback = new RecordingJsCallback();
        SessionForkService forkService = new SessionForkService(
                new HandlerContext(stubProject(), null, null, null, callback), null);
        try {
            forkService.forkSession("{\"sessionId\":\"" + SOURCE_ID + "\"}", null,
                    claudeHome.getParent().getParent());
        } finally {
            Files.setPosixFilePermissions(claudeHome, restore);
        }

        assertEquals("FORK_FAILED", forkResultCode(callback));
    }

    @Test
    public void forkSessionForksASessionFoundByScanningTheTempHome() throws IOException {
        Path projectDir = newClaudeHome().resolve("whatever-key");
        Files.createDirectories(projectDir);
        Path source = projectDir.resolve(SOURCE_ID + ".jsonl");
        Files.write(source, List.of(
                "{\"uuid\":\"u1\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"user\"}",
                "{\"uuid\":\"u2\",\"parentUuid\":\"u1\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"assistant\"}"
        ), StandardCharsets.UTF_8);

        RecordingJsCallback callback = new RecordingJsCallback();
        RecordingTitleCaller caller = new RecordingTitleCaller();
        SessionForkService forkService = new SessionForkService(
                new HandlerContext(stubProject(), null, null, null, callback), caller);

        // No projectPath: the scan-all-projects branch has to find the file.
        forkService.forkSession("{\"sessionId\":\"" + SOURCE_ID + "\"}", null,
                claudeHomeRoot());

        String result = forkResultJson(callback);
        assertTrue(result.contains("\"success\":true"));
        assertFalse(result.contains(SOURCE_ID));
        // The fork lands next to its source under the temp home, ids rewritten.
        String newSessionId = result.replaceAll(".*\"newSessionId\":\"([^\"]+)\".*", "$1");
        Path forkFile = projectDir.resolve(newSessionId + ".jsonl");
        assertTrue(Files.exists(forkFile));
        assertTrue(Files.readString(forkFile, StandardCharsets.UTF_8).contains("\"sessionId\":\"" + newSessionId + "\""));
        assertNoTempFiles(projectDir);
    }

    @Test
    public void forkSessionReportsAMissingForkPoint() throws IOException {
        Path projectDir = newClaudeHome().resolve("whatever-key");
        Files.createDirectories(projectDir);
        Files.write(projectDir.resolve(SOURCE_ID + ".jsonl"), List.of(
                "{\"uuid\":\"u1\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"user\"}"
        ), StandardCharsets.UTF_8);

        RecordingJsCallback callback = new RecordingJsCallback();
        SessionForkService forkService = new SessionForkService(
                new HandlerContext(stubProject(), null, null, null, callback), null);

        forkService.forkSession(
                "{\"sessionId\":\"" + SOURCE_ID + "\",\"forkPointUuid\":\"" + FORK_ID + "\"}", null,
                claudeHomeRoot());

        assertEquals("FORK_POINT_NOT_FOUND", forkResultCode(callback));
    }

    @Test
    public void forkSessionReportsAnUnresolvedToolUseAtTheForkPoint() throws IOException {
        // The clicked reply's own turn was interrupted mid-tool-call: no cut
        // keeps the reply while dropping the call, so the fork is refused with
        // its own code instead of a generic failure.
        Path projectDir = newClaudeHome().resolve("whatever-key");
        Files.createDirectories(projectDir);
        Files.write(projectDir.resolve(SOURCE_ID + ".jsonl"), List.of(
                "{\"uuid\":\"" + U1 + "\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"user\","
                        + "\"message\":{\"role\":\"user\",\"content\":\"hello\"}}",
                "{\"uuid\":\"" + A1 + "\",\"parentUuid\":\"" + U1 + "\",\"sessionId\":\"" + SOURCE_ID + "\","
                        + "\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":"
                        + "[{\"type\":\"tool_use\",\"id\":\"t9\"}]}}"
        ), StandardCharsets.UTF_8);

        RecordingJsCallback callback = new RecordingJsCallback();
        SessionForkService forkService = new SessionForkService(
                new HandlerContext(stubProject(), null, null, null, callback), null);

        forkService.forkSession(
                "{\"sessionId\":\"" + SOURCE_ID + "\",\"forkPointUuid\":\"" + A1 + "\"}", null,
                claudeHomeRoot());

        assertEquals("UNRESOLVED_TOOL_USE", forkResultCode(callback));
    }

    @Test
    public void forkSessionTruncatesTheTitleBeforeTheTitlesService() throws IOException {
        Path projectDir = newClaudeHome().resolve("whatever-key");
        Files.createDirectories(projectDir);
        Files.write(projectDir.resolve(SOURCE_ID + ".jsonl"),
                List.of("{\"uuid\":\"u1\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"user\"}"),
                StandardCharsets.UTF_8);

        RecordingJsCallback callback = new RecordingJsCallback();
        RecordingTitleCaller caller = new RecordingTitleCaller();
        SessionForkService forkService = new SessionForkService(
                new HandlerContext(stubProject(), null, null, null, callback), caller);

        String longTitle = "t".repeat(SessionForkService.MAX_TITLE_LENGTH) + "😀tail";
        forkService.forkSession("{\"sessionId\":\"" + SOURCE_ID + "\",\"title\":\"" + longTitle + "\"}", null,
                claudeHomeRoot());

        assertTrue("fork success must not depend on the title",
                forkResultJson(callback).contains("\"success\":true"));
        // The service received at most the 50-unit limit, without a split pair.
        assertEquals(1, caller.titles.size());
        String sent = caller.titles.get(0);
        assertTrue("title must fit the service limit: " + sent.length(),
                sent.length() <= SessionForkService.MAX_TITLE_LENGTH);
        assertFalse("no split surrogate may be persisted",
                Character.isHighSurrogate(sent.charAt(sent.length() - 1)));
    }

    @Test
    public void forkSessionKeepsTheForkUsableWhenTheTitleServiceRejectsTheTitle() throws IOException {
        Path projectDir = newClaudeHome().resolve("whatever-key");
        Files.createDirectories(projectDir);
        Files.write(projectDir.resolve(SOURCE_ID + ".jsonl"),
                List.of("{\"uuid\":\"u1\",\"sessionId\":\"" + SOURCE_ID + "\",\"type\":\"user\"}"),
                StandardCharsets.UTF_8);

        RecordingJsCallback callback = new RecordingJsCallback();
        RecordingTitleCaller caller = new RecordingTitleCaller();
        caller.nextReply = "{\"success\":false,\"error\":\"Title too long\"}";
        SessionForkService forkService = new SessionForkService(
                new HandlerContext(stubProject(), null, null, null, callback), caller);

        forkService.forkSession("{\"sessionId\":\"" + SOURCE_ID + "\",\"title\":\"fork title\"}", null,
                claudeHomeRoot());

        assertTrue("a rejected title must not fail the fork",
                forkResultJson(callback).contains("\"success\":true"));
    }

    @Test
    public void copySessionFileFailsOnAMissingSourceWithoutLeavingTempFiles() throws IOException {
        Path dir = temporaryFolder.newFolder("project-missing").toPath();
        Path missingSource = dir.resolve(SOURCE_ID + ".jsonl");
        Path target = dir.resolve(FORK_ID + ".jsonl");

        try {
            service.copySessionFile(missingSource, target, SOURCE_ID, FORK_ID, null);
            throw new AssertionError("a missing source must fail the copy");
        } catch (IOException expected) {
            // NoSuchFileException or a wrapped equivalent — both are fine.
        }

        assertFalse(Files.exists(target));
        assertNoTempFiles(dir);
    }

    private static String forkResultCode(RecordingJsCallback callback) {
        String json = forkResultJson(callback);
        Matcher matcher = Pattern.compile("\"errorCode\":\"([^\"]+)\"").matcher(json);
        assertTrue("expected an errorCode in: " + json, matcher.find());
        return matcher.group(1);
    }
}

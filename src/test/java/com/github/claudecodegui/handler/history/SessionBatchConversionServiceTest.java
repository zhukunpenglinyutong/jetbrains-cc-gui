package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Coverage for the server-side batch conversion of SDK sessions to CLI sessions.
 *
 * <p>The service is built from injected suppliers, and the real {@link SessionConversionService}
 * is pointed at a temporary projects directory, so these tests run without an IntelliJ
 * application, without a webview, and without touching the developer's real session history.
 */
public class SessionBatchConversionServiceTest {

    private static final String SDK_CLI = "sdk-cli";
    private static final String CLAUDE_VSCODE = "claude-vscode";

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    private Path projectsDir;
    private Path projectDir;

    /**
     * Results emitted by the service, in emission order. Synchronized because the worker
     * thread and the test thread both write to it.
     */
    private final List<JsonObject> results = Collections.synchronizedList(new ArrayList<>());

    /** Counts converter invocations so the overlap test can prove the second call was a no-op. */
    private final AtomicInteger converterCalls = new AtomicInteger();

    @Before
    public void createProjectsDir() throws IOException {
        this.projectsDir = temporaryFolder.newFolder("projects-root").toPath();
        this.projectDir = this.projectsDir.resolve("proj");
        Files.createDirectories(this.projectDir);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private Path writeSessionFile(String sessionId, String entrypoint) throws IOException {
        Path file = this.projectDir.resolve(sessionId + ".jsonl");
        Files.writeString(file, "{\"type\":\"user\",\"entrypoint\":\"" + entrypoint + "\"}\n",
                StandardCharsets.UTF_8);
        return file;
    }

    /** Real conversion logic, rooted at the temporary projects directory. */
    private SessionBatchConversionService.SingleSessionConverter realConverter() {
        SessionConversionService conversionService = new SessionConversionService(null, () -> this.projectsDir);
        return (sessionId, projectPath) -> {
            this.converterCalls.incrementAndGet();
            // A null project path makes the finder scan every project directory, which keeps
            // the test independent of the path-sanitizing rules.
            return conversionService.convertSession(sessionId, null);
        };
    }

    private SessionBatchConversionService service(
            List<SessionBatchConversionService.SessionCandidate> candidates,
            String activeSessionId,
            SessionBatchConversionService.SingleSessionConverter converter
    ) {
        return this.service(candidates, activeSessionId, converter, Runnable::run);
    }

    private SessionBatchConversionService service(
            List<SessionBatchConversionService.SessionCandidate> candidates,
            String activeSessionId,
            SessionBatchConversionService.SingleSessionConverter converter,
            Executor executor
    ) {
        return new SessionBatchConversionService(
                () -> candidates,
                () -> activeSessionId,
                () -> null,
                converter,
                this.results::add,
                executor
        );
    }

    private static List<SessionBatchConversionService.SessionCandidate> candidates(
            String... sessionIdAndEntrypointPairs) {
        List<SessionBatchConversionService.SessionCandidate> list = new ArrayList<>();
        for (int i = 0; i < sessionIdAndEntrypointPairs.length; i += 2) {
            list.add(new SessionBatchConversionService.SessionCandidate(
                    sessionIdAndEntrypointPairs[i], sessionIdAndEntrypointPairs[i + 1]));
        }
        return list;
    }

    private void awaitResults(int expected) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (this.results.size() < expected && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
    }

    private static List<String> stringsOf(JsonObject result, String field) {
        JsonArray array = result.getAsJsonArray(field);
        List<String> values = new ArrayList<>();
        for (int i = 0; i < array.size(); i++) {
            values.add(array.get(i).getAsString());
        }
        return values;
    }

    // ── happy path ─────────────────────────────────────────────────────────

    @Test
    public void convertsEveryConvertibleSessionAndAggregatesCounts() throws IOException {
        Path first = writeSessionFile("11111111-1111-1111-1111-111111111111", SDK_CLI);
        Path second = writeSessionFile("22222222-2222-2222-2222-222222222222", CLAUDE_VSCODE);
        Path third = writeSessionFile("33333333-3333-3333-3333-333333333333", SDK_CLI);

        JsonObject result = service(
                candidates(
                        "11111111-1111-1111-1111-111111111111", SDK_CLI,
                        "22222222-2222-2222-2222-222222222222", CLAUDE_VSCODE,
                        "33333333-3333-3333-3333-333333333333", SDK_CLI),
                null,
                realConverter()
        ).runBatch();

        assertEquals(SessionBatchConversionService.STATUS_COMPLETED, result.get("status").getAsString());
        assertEquals(3, result.get("total").getAsInt());
        assertEquals(3, result.get("converted").getAsInt());
        assertEquals(0, result.get("skipped").getAsInt());
        assertEquals(0, result.get("failed").getAsInt());
        assertEquals(List.of(), stringsOf(result, "failedSessionIds"));

        for (Path file : List.of(first, second, third)) {
            assertTrue(Files.readString(file, StandardCharsets.UTF_8).contains("\"entrypoint\":\"cli\""));
        }
    }

    @Test
    public void nonConvertibleEntrypointsAreNotPartOfTheBatch() throws IOException {
        Path cliSession = writeSessionFile("aaaaaaaa-1111-1111-1111-111111111111", "cli");
        Path remoteSession = writeSessionFile("bbbbbbbb-2222-2222-2222-222222222222", "remote");
        byte[] cliBefore = Files.readAllBytes(cliSession);
        byte[] remoteBefore = Files.readAllBytes(remoteSession);

        JsonObject result = service(
                candidates(
                        "aaaaaaaa-1111-1111-1111-111111111111", "cli",
                        "bbbbbbbb-2222-2222-2222-222222222222", "remote",
                        "cccccccc-3333-3333-3333-333333333333", null,
                        "dddddddd-4444-4444-4444-444444444444", "some-future-entrypoint"),
                null,
                realConverter()
        ).runBatch();

        assertEquals(0, result.get("total").getAsInt());
        assertEquals(0, result.get("converted").getAsInt());
        assertEquals(0, this.converterCalls.get());

        assertArrayEquals(cliBefore, Files.readAllBytes(cliSession));
        assertArrayEquals(remoteBefore, Files.readAllBytes(remoteSession));
    }

    // ── failures ───────────────────────────────────────────────────────────

    @Test
    public void missingSessionFileIsCountedAsFailed() throws IOException {
        writeSessionFile("11111111-1111-1111-1111-111111111111", SDK_CLI);
        String ghostId = "99999999-9999-9999-9999-999999999999";

        JsonObject result = service(
                candidates(
                        "11111111-1111-1111-1111-111111111111", SDK_CLI,
                        ghostId, SDK_CLI),
                null,
                realConverter()
        ).runBatch();

        assertEquals(SessionBatchConversionService.STATUS_COMPLETED, result.get("status").getAsString());
        assertEquals(2, result.get("total").getAsInt());
        assertEquals(1, result.get("converted").getAsInt());
        assertEquals(1, result.get("failed").getAsInt());
        assertEquals(List.of(ghostId), stringsOf(result, "failedSessionIds"));
        assertEquals("SESSION_NOT_FOUND",
                result.getAsJsonObject("errorCodes").get(ghostId).getAsString());
    }

    @Test
    public void converterExceptionFailsOnlyThatSession() throws IOException {
        Path healthy = writeSessionFile("11111111-1111-1111-1111-111111111111", SDK_CLI);
        String boomId = "22222222-2222-2222-2222-222222222222";
        writeSessionFile(boomId, SDK_CLI);

        SessionBatchConversionService.SingleSessionConverter throwing = (sessionId, projectPath) -> {
            if (sessionId.equals(boomId)) {
                throw new IllegalStateException("boom");
            }
            return realConverter().convert(sessionId, projectPath);
        };

        JsonObject result = service(
                candidates(
                        "11111111-1111-1111-1111-111111111111", SDK_CLI,
                        boomId, SDK_CLI),
                null,
                throwing
        ).runBatch();

        assertEquals(1, result.get("converted").getAsInt());
        assertEquals(1, result.get("failed").getAsInt());
        assertEquals(List.of(boomId), stringsOf(result, "failedSessionIds"));
        assertEquals("CONVERSION_FAILED",
                result.getAsJsonObject("errorCodes").get(boomId).getAsString());
        assertTrue(Files.readString(healthy, StandardCharsets.UTF_8).contains("\"entrypoint\":\"cli\""));
    }

    @Test
    public void unreadableHistoryIndexYieldsFailedStatus() {
        SessionBatchConversionService service = new SessionBatchConversionService(
                () -> {
                    throw new IllegalStateException("index unavailable");
                },
                () -> null,
                () -> null,
                realConverter(),
                this.results::add,
                Runnable::run
        );

        service.convertAll();

        assertEquals(1, this.results.size());
        JsonObject result = this.results.get(0);
        assertEquals(SessionBatchConversionService.STATUS_FAILED, result.get("status").getAsString());
        assertEquals(0, result.get("converted").getAsInt());
        assertEquals(0, this.converterCalls.get());
    }

    // ── active session ─────────────────────────────────────────────────────

    @Test
    public void activeSessionIsSkippedAndLeftByteForByteIntact() throws IOException {
        Path activeFile = writeSessionFile("11111111-1111-1111-1111-111111111111", SDK_CLI);
        writeSessionFile("22222222-2222-2222-2222-222222222222", SDK_CLI);
        byte[] activeBefore = Files.readAllBytes(activeFile);

        JsonObject result = service(
                candidates(
                        "11111111-1111-1111-1111-111111111111", SDK_CLI,
                        "22222222-2222-2222-2222-222222222222", SDK_CLI),
                "11111111-1111-1111-1111-111111111111",
                realConverter()
        ).runBatch();

        assertEquals(SessionBatchConversionService.STATUS_COMPLETED, result.get("status").getAsString());
        assertEquals(1, result.get("converted").getAsInt());
        assertEquals(1, result.get("skipped").getAsInt());
        // The active session must be reported as skipped, never as a failure.
        assertEquals(0, result.get("failed").getAsInt());
        assertEquals(List.of("11111111-1111-1111-1111-111111111111"), stringsOf(result, "skippedSessionIds"));
        assertEquals(List.of(), stringsOf(result, "failedSessionIds"));

        assertArrayEquals(activeBefore, Files.readAllBytes(activeFile));
        assertEquals(1, this.converterCalls.get());
    }

    @Test
    public void invalidSessionIdIsSkippedWithoutTouchingTheFilesystem() throws IOException {
        JsonObject result = service(
                candidates("../../etc/passwd", SDK_CLI),
                null,
                realConverter()
        ).runBatch();

        assertEquals(1, result.get("skipped").getAsInt());
        assertEquals(0, result.get("failed").getAsInt());
        assertEquals(0, result.get("converted").getAsInt());
        assertEquals(0, this.converterCalls.get());
    }

    // ── overlap protection ─────────────────────────────────────────────────

    @Test
    public void overlappingSecondCallIsRejectedAndChangesNoFile() throws Exception {
        String blockedId = "11111111-1111-1111-1111-111111111111";
        Path blockedFile = writeSessionFile(blockedId, SDK_CLI);
        writeSessionFile("22222222-2222-2222-2222-222222222222", SDK_CLI);

        CountDownLatch converterStarted = new CountDownLatch(1);
        CountDownLatch releaseConverter = new CountDownLatch(1);
        SessionConversionService real = new SessionConversionService(null, () -> this.projectsDir);

        SessionBatchConversionService.SingleSessionConverter blocking = (sessionId, projectPath) -> {
            this.converterCalls.incrementAndGet();
            converterStarted.countDown();
            try {
                releaseConverter.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return real.convertSession(sessionId, projectPath);
        };

        Executor threadPerTask = runnable -> {
            Thread thread = new Thread(runnable, "batch-conversion-test");
            thread.start();
        };

        SessionBatchConversionService service = service(
                candidates(
                        blockedId, SDK_CLI,
                        "22222222-2222-2222-2222-222222222222", SDK_CLI),
                null,
                blocking,
                threadPerTask
        );

        service.convertAll();
        assertTrue("the first batch never reached the converter", converterStarted.await(10, TimeUnit.SECONDS));

        Map<String, byte[]> beforeSecondCall = snapshotProjectDir();

        // Second click while the first batch is still in flight.
        service.convertAll();

        assertEquals(1, this.results.size());
        JsonObject rejected = this.results.get(0);
        assertEquals(SessionBatchConversionService.STATUS_ALREADY_RUNNING, rejected.get("status").getAsString());
        assertEquals(0, rejected.get("converted").getAsInt());
        assertEquals(0, rejected.get("total").getAsInt());
        assertEquals(List.of(), stringsOf(rejected, "skippedSessionIds"));
        assertEquals(List.of(), stringsOf(rejected, "failedSessionIds"));

        // The rejected call must not have converted anything, let alone the blocked session.
        assertEquals(1, this.converterCalls.get());
        assertSnapshotsEqual(beforeSecondCall, snapshotProjectDir());

        releaseConverter.countDown();
        awaitResults(2);

        JsonObject completed = this.results.get(1);
        assertEquals(SessionBatchConversionService.STATUS_COMPLETED, completed.get("status").getAsString());
        assertEquals(2, completed.get("converted").getAsInt());
        assertEquals(2, this.converterCalls.get());

        // The guard is released, so a later batch runs normally.
        service.convertAll();
        awaitResults(3);
    }

    private Map<String, byte[]> snapshotProjectDir() throws IOException {
        Map<String, byte[]> snapshot = new TreeMap<>();
        try (Stream<Path> files = Files.list(this.projectDir)) {
            for (Path file : files.toList()) {
                snapshot.put(file.getFileName().toString(), Files.readAllBytes(file));
            }
        }
        return snapshot;
    }

    private static void assertSnapshotsEqual(Map<String, byte[]> expected, Map<String, byte[]> actual) {
        assertEquals(expected.keySet(), actual.keySet());
        for (String key : expected.keySet()) {
            assertArrayEquals("file " + key + " changed during the rejected batch", expected.get(key), actual.get(key));
        }
    }
}

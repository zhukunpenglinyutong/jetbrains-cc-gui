package com.github.claudecodegui.bridge;

import com.github.claudecodegui.testing.TrackingProcessManager;
import com.github.claudecodegui.util.PlatformUtils;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * I/O ordering tests for {@link NodeProcessRunner}. The per-caller timeout tests
 * live next to the callers; these cover what a single synchronous thread cannot
 * do: feed stdin and drain stdout at the same time, survive a broken stdin pipe,
 * and notice stdout left open after the child exited.
 */
public class NodeProcessRunnerTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    private static final long TIMEOUT_SECONDS = 20;
    private static final int PAYLOAD_LINES = 40_000;

    private final TrackingProcessManager processManager = new TrackingProcessManager();

    @Test(timeout = 30_000)
    public void echoesLargeStdinWhileDrainingStdout() throws Exception {
        // The child only reads more stdin once its stdout has been consumed, so
        // writing all of stdin before reading stdout deadlocks on a large payload.
        String payload = largePayload();

        NodeProcessRunner.Result result = NodeProcessRunner.run(
                node("process.stdin.pipe(process.stdout);"),
                processManager, "runner-test", payload, TIMEOUT_SECONDS);

        assertEquals(0, result.exitCode());
        assertEquals(payload, result.output());
        assertEquals(line(PAYLOAD_LINES - 1), result.lastLine());
        assertEquals(0, processManager.getActiveProcessCount());
    }

    @Test(timeout = 30_000)
    public void childExitingWithoutReadingStdinReportsItsExitCode() throws Exception {
        // The stdin writer hits a broken pipe; that must not turn into a hang or
        // mask the child's own exit code.
        NodeProcessRunner.Result result = NodeProcessRunner.run(
                node("console.log('bye'); process.exitCode = 3;"),
                processManager, "runner-test", largePayload(), TIMEOUT_SECONDS);

        assertEquals(3, result.exitCode());
        assertEquals("bye", result.lastLine());
        assertEquals(1, processManager.unregisterCalls.get());
        assertEquals(0, processManager.getActiveProcessCount());
    }

    @Test
    public void emptyOutputHasEmptyLastLine() throws Exception {
        NodeProcessRunner.Result result = NodeProcessRunner.run(
                node(""), processManager, "runner-test", null, TIMEOUT_SECONDS);

        assertEquals(0, result.exitCode());
        assertEquals("", result.lastLine());
    }

    @Test
    public void lineBreaksOnlyOutputFallsBackToEmptyJsonObject() throws Exception {
        // "\n".split("\n") is an empty array; the callers' old "{}" fallback covered it.
        NodeProcessRunner.Result result = NodeProcessRunner.run(
                node("console.log(); console.log();"), processManager, "runner-test", null, TIMEOUT_SECONDS);

        assertEquals("{}", result.lastLine());
    }

    @Test
    public void trailingBlankLinesAreSkipped() throws Exception {
        NodeProcessRunner.Result result = NodeProcessRunner.run(
                node("console.log('{\"ok\":true}'); console.log();"),
                processManager, "runner-test", null, TIMEOUT_SECONDS);

        assertEquals("{\"ok\":true}", result.lastLine());
    }

    @Test(timeout = 30_000)
    public void stdoutHeldOpenAfterExitFailsInsteadOfReturningPartialOutput() throws Exception {
        // Relies on a detached grandchild keeping the inherited stdout pipe open
        // after its parent exits; Windows job objects make that platform-specific.
        // Best effort in production too: see the comment on the exit delay below.
        Assume.assumeFalse(PlatformUtils.isWindows());
        Path pidFile = temporaryFolder.getRoot().toPath().resolve("grandchild.pid");
        ProcessBuilder pb = node(
                "const { spawn } = require('child_process');"
                        + "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'],"
                        + " { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });"
                        + "require('fs').writeFileSync(process.argv[1], String(child.pid));"
                        + "child.unref();"
                        + "console.log('partial');"
                        // Exit only once the reader is parked in read(): if it is between
                        // reads when the JDK reaps the child, the JDK itself swaps stdout
                        // for an EOF stream and the open pipe goes unnoticed.
                        + "setTimeout(() => {}, 300);",
                pidFile.toString());
        try {
            long start = System.currentTimeMillis();
            IOException e = assertThrows(IOException.class, () -> NodeProcessRunner.run(
                    pb, processManager, "runner-test", null, TIMEOUT_SECONDS));
            long elapsed = System.currentTimeMillis() - start;

            assertTrue("expected an undrained-stdout error, got: " + e.getMessage(),
                    e.getMessage().contains("stdout was still open"));
            assertTrue("should fail shortly after the child exits (took " + elapsed + " ms)",
                    elapsed < NodeProcessRunner.OUTPUT_DRAIN_MILLIS + 8_000);
            assertEquals(0, processManager.getActiveProcessCount());
            assertFalse(processManager.registeredProcess.get().isAlive());
        } finally {
            killGrandchild(pidFile);
        }
    }

    private static ProcessBuilder node(String script, String... args) {
        List<String> command = new ArrayList<>(List.of("node", "-e", script));
        command.addAll(List.of(args));
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.redirectErrorStream(true);
        return pb;
    }

    private static String largePayload() {
        StringBuilder payload = new StringBuilder();
        for (int i = 0; i < PAYLOAD_LINES; i++) {
            payload.append(line(i)).append('\n');
        }
        return payload.toString();
    }

    private static String line(int index) {
        return "line-" + index + "-" + "y".repeat(40);
    }

    private static void killGrandchild(Path pidFile) throws IOException {
        if (!Files.exists(pidFile)) {
            return;
        }
        long pid = Long.parseLong(Files.readString(pidFile, StandardCharsets.UTF_8).trim());
        ProcessHandle.of(pid).ifPresent(ProcessHandle::destroyForcibly);
    }
}

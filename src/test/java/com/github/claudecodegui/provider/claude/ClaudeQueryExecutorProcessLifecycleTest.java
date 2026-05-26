package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.testing.TrackingProcessManager;
import com.google.gson.Gson;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for {@link ClaudeQueryExecutor#executeQueryStream} process
 * lifecycle management (task L3 in
 * {@code .workflow/.scratchpad/NODE_PROCESS_LEAK_FIX_TASKS.md}).
 *
 * <p>The original code path forked a Node.js child via {@code pb.start()} but
 * never called {@link ProcessManager#registerProcess(String, Process)}, so
 * {@code cleanupAllProcesses} on IDE shutdown could not see the child and a
 * stalled SDK call would leave a zombie process behind. These tests verify
 * that the fix:
 * <ol>
 *   <li>registers the child before starting any I/O,</li>
 *   <li>unregisters it in the finally block on every exit path,</li>
 *   <li>ends with zero active processes (no leak).</li>
 * </ol>
 *
 * <p>To avoid depending on a real Node.js installation, we substitute the
 * JVM as the "node" binary — running {@code java simple-query.js} fails fast
 * with "class not found" and exits the child immediately. The lifecycle
 * contract we care about is identical whether the child succeeds or fails.
 */
public class ClaudeQueryExecutorProcessLifecycleTest {

    /** Returns the path to the JVM running this test — a guaranteed-present binary. */
    private static String javaExecutable() {
        return System.getProperty("java.home") + File.separator + "bin"
                + File.separator + "java";
    }

    private TrackingProcessManager processManager;
    private File workDir;

    @Before
    public void setUp() throws IOException {
        processManager = new TrackingProcessManager();
        workDir = Files.createTempDirectory("claude-query-executor-test").toFile();
    }

    private ClaudeQueryExecutor newExecutor() throws Exception {
        // Pretend `java` is the "node" binary. The executor will spawn
        // `java simple-query.js`, which fails fast (class not found) and exits.
        // NodeDetector has a private constructor (singleton), so we inject the
        // cached path via reflection — `findNodeExecutable` returns it directly
        // without running real detection.
        NodeDetector.resetInstance();
        NodeDetector node = NodeDetector.getInstance();
        Field cache = NodeDetector.class.getDeclaredField("cachedNodeExecutable");
        cache.setAccessible(true);
        cache.set(node, javaExecutable());

        return new ClaudeQueryExecutor(
                new Gson(),
                node,
                () -> workDir,
                processManager,
                new EnvironmentConfigurator(),
                new ClaudeJsonOutputExtractor()
        );
    }

    /** Captures callback events without doing anything else. */
    private static class RecordingCallback implements MessageCallback {
        final List<String> messages = new ArrayList<>();
        SDKResult completedWith;
        String errorWith;

        @Override
        public void onMessage(String type, String content) {
            messages.add(type + ":" + content);
        }

        @Override
        public void onComplete(SDKResult result) {
            completedWith = result;
        }

        @Override
        public void onError(String error) {
            errorWith = error;
        }
    }

    @Test
    public void executeQueryStream_registersAndUnregistersChild() throws Exception {
        ClaudeQueryExecutor executor = newExecutor();
        RecordingCallback callback = new RecordingCallback();

        SDKResult result = executor.executeQueryStream("hello", callback)
                .get(30, TimeUnit.SECONDS);

        assertNotNull(result);

        // The original (buggy) code never called registerProcess at all.
        assertEquals("child must be registered before any I/O",
                1, processManager.registerCalls.get());
        assertEquals("child must be unregistered in finally",
                1, processManager.unregisterCalls.get());

        // Same channelId on both sides — register/unregister must be balanced.
        assertEquals(processManager.lastRegisteredChannelId.get(),
                processManager.lastUnregisteredChannelId.get());

        // Same Process reference — guards against the bug-1010 class of issue
        // where a fresh Process was passed to unregister.
        assertSame(processManager.registeredProcess.get(),
                processManager.unregisteredProcess.get());

        // Channel ID convention used by the Node Process management panel.
        assertNotNull(processManager.lastRegisteredChannelId.get());
        assertTrue("channelId should be prefixed",
                processManager.lastRegisteredChannelId.get()
                        .startsWith("claude-query-stream-"));
    }

    @Test
    public void executeQueryStream_leavesNoActiveProcesses() throws Exception {
        ClaudeQueryExecutor executor = newExecutor();
        RecordingCallback callback = new RecordingCallback();

        executor.executeQueryStream("hello", callback).get(30, TimeUnit.SECONDS);

        // The whole point of L3: nothing leaks. ProcessManager's active set
        // must be empty after the call returns, on every exit path.
        assertEquals("no lingering active processes",
                0, processManager.getActiveProcessCount());

        // And the child itself must be dead — the finally block force-kills
        // any still-alive process as a last resort.
        assertFalse("child process must not outlive the call",
                processManager.registeredProcess.get().isAlive());
    }

    // ----- L4: executeQuerySync ----------------------------------------------

    @Test
    public void executeQuerySync_registersAndUnregistersChild() throws Exception {
        ClaudeQueryExecutor executor = newExecutor();

        // 30s timeout is well over `java simple-query.js` exit-on-error duration.
        executor.executeQuerySync("hello", 30);

        // Same contract as the stream path: register before I/O, unregister in finally.
        assertEquals("child must be registered",
                1, processManager.registerCalls.get());
        assertEquals("child must be unregistered in finally",
                1, processManager.unregisterCalls.get());
        assertEquals(processManager.lastRegisteredChannelId.get(),
                processManager.lastUnregisteredChannelId.get());
        assertNotNull(processManager.lastRegisteredChannelId.get());
        assertTrue("channelId convention for the Node Process panel",
                processManager.lastRegisteredChannelId.get()
                        .startsWith("claude-query-sync-"));
        assertEquals("no lingering active processes",
                0, processManager.getActiveProcessCount());
        assertFalse("child must not outlive the call",
                processManager.registeredProcess.get().isAlive());
    }
}

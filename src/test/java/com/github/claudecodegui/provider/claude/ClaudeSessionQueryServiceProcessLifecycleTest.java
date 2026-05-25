package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.testing.TrackingProcessManager;
import com.google.gson.Gson;
import com.intellij.openapi.diagnostic.Logger;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.file.Files;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for {@link ClaudeSessionQueryService#runSessionQuery} process
 * lifecycle management (task L5 in
 * {@code .workflow/.scratchpad/NODE_PROCESS_LEAK_FIX_TASKS.md}).
 *
 * <p>The original code spawned a Node.js child via {@code pb.start()} but
 * never registered with {@link ProcessManager}, so a stalled session query
 * leaked the node process for the lifetime of the IDE. We verify the fix:
 * the child is registered before I/O, unregistered in finally, and force-killed
 * if still alive.
 */
public class ClaudeSessionQueryServiceProcessLifecycleTest {

    private static String javaExecutable() {
        return System.getProperty("java.home") + File.separator + "bin"
                + File.separator + "java";
    }

    private TrackingProcessManager processManager;
    private File workDir;
    private NodeDetector node;

    @Before
    public void setUp() throws Exception {
        processManager = new TrackingProcessManager();
        workDir = Files.createTempDirectory("claude-session-query-test").toFile();
        NodeDetector.resetInstance();
        node = NodeDetector.getInstance();
        Field cache = NodeDetector.class.getDeclaredField("cachedNodeExecutable");
        cache.setAccessible(true);
        cache.set(node, javaExecutable());
    }

    @Test
    public void runSessionQuery_registersAndUnregistersChild() throws IOException {
        ClaudeSessionQueryService service = new ClaudeSessionQueryService(
                Logger.getInstance(ClaudeSessionQueryServiceProcessLifecycleTest.class),
                new Gson(),
                node,
                () -> workDir,
                processManager,
                new EnvironmentConfigurator(),
                new ClaudeJsonOutputExtractor()
        );

        // getSessionMessages will fail because there's no valid Node output to parse.
        // IntelliJ's DefaultLogger turns log.error() into AssertionError in tests, so
        // we catch Throwable. The failure happens AFTER the process lifecycle is
        // complete, which is exactly the path the regression test must cover.
        try {
            service.getSessionMessages("test-session-id", workDir.getAbsolutePath());
        } catch (Throwable expected) {
            // expected — no real session data exists
        }

        // The lifecycle bookkeeping is what matters: register before I/O, unregister
        // in finally, no leak, child dead.
        assertEquals("child must be registered before I/O",
                1, processManager.registerCalls.get());
        assertEquals("child must be unregistered in finally (even on exception path)",
                1, processManager.unregisterCalls.get());
        assertEquals(processManager.lastRegisteredChannelId.get(),
                processManager.lastUnregisteredChannelId.get());
        assertSame(processManager.registeredProcess.get(),
                processManager.unregisteredProcess.get());
        assertNotNull(processManager.lastRegisteredChannelId.get());
        assertTrue("channelId convention used by Node Process panel",
                processManager.lastRegisteredChannelId.get()
                        .startsWith("claude-session-query-"));
        assertEquals("no lingering active processes",
                0, processManager.getActiveProcessCount());
        assertFalse("child must not outlive the call",
                processManager.registeredProcess.get().isAlive());
    }
}

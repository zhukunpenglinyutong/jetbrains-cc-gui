package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.testing.TrackingProcessManager;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Regression test for {@link ClaudeRewindService#rewindFiles} process lifecycle
 * (task L6 in {@code .workflow/.scratchpad/NODE_PROCESS_LEAK_FIX_TASKS.md}).
 *
 * <p>The original code spawned a Node.js child without registering it with
 * {@link ProcessManager}. We verify that the fix registers before I/O,
 * unregisters in finally, and leaves no process behind on the failure path.
 */
public class ClaudeRewindServiceProcessLifecycleTest {

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
        workDir = Files.createTempDirectory("claude-rewind-test").toFile();
        NodeDetector.resetInstance();
        node = NodeDetector.getInstance();
        Field cache = NodeDetector.class.getDeclaredField("cachedNodeExecutable");
        cache.setAccessible(true);
        cache.set(node, javaExecutable());
    }

    @Test
    public void rewindFiles_registersAndUnregistersChild() throws Exception {
        ClaudeRewindService service = new ClaudeRewindService(
                Logger.getInstance(ClaudeRewindServiceProcessLifecycleTest.class),
                new Gson(),
                node,
                () -> workDir,
                processManager,
                new EnvironmentConfigurator(),
                new ClaudeJsonOutputExtractor()
        );

        // The rewind returns a JsonObject (success=false here because Node fails fast),
        // but we don't care about the response — the lifecycle is what's tested.
        JsonObject response = service.rewindFiles(
                "test-session-id", "msg-id", workDir.getAbsolutePath()
        ).get(30, TimeUnit.SECONDS);
        assertNotNull(response);

        assertEquals("child must be registered before I/O",
                1, processManager.registerCalls.get());
        assertEquals("child must be unregistered in finally",
                1, processManager.unregisterCalls.get());
        assertEquals(processManager.lastRegisteredChannelId.get(),
                processManager.lastUnregisteredChannelId.get());
        assertSame(processManager.registeredProcess.get(),
                processManager.unregisteredProcess.get());
        assertNotNull(processManager.lastRegisteredChannelId.get());
        assertTrue("channelId convention",
                processManager.lastRegisteredChannelId.get()
                        .startsWith("claude-rewind-"));
        assertEquals("no lingering active processes",
                0, processManager.getActiveProcessCount());
        assertFalse("child must not outlive the call",
                processManager.registeredProcess.get().isAlive());
    }
}

package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.testing.TrackingProcessManager;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeoutException;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Regression tests for {@link PromptEnhancerProcessRunner}.
 *
 * <p>These guard against the L1 leak documented in
 * {@code .workflow/.scratchpad/NODE_PROCESS_LEAK_FIX_TASKS.md}: the original
 * {@code PromptEnhancerHandler#callAIForEnhancement} called
 * {@code process.waitFor()} without a timeout, never registered the child
 * with {@link ProcessManager}, and had no finally cleanup. A hung Node
 * process leaked for the lifetime of the IDE.
 *
 * <p>We launch a tiny in-process Java helper as the child process so the
 * tests are deterministic and cross-platform — no reliance on
 * {@code sleep}/{@code cat}/{@code echo}.
 */
public class PromptEnhancerProcessRunnerTest {

    private TrackingProcessManager pm;

    @Before
    public void setUp() {
        pm = new TrackingProcessManager();
    }

    // ----- Test fixture helpers ------------------------------------------------

    /**
     * Builds a ProcessBuilder that launches the current JVM running the given
     * helper main class with the given args. The classpath is inherited from
     * the test JVM so {@link TestChildEcho} and {@link TestChildSleep} are
     * findable.
     */
    private ProcessBuilder javaChild(Class<?> mainClass, String... args) {
        String javaBin = System.getProperty("java.home") + File.separator + "bin"
                + File.separator + "java";
        String classpath = System.getProperty("java.class.path");
        List<String> cmd = new ArrayList<>();
        cmd.add(javaBin);
        cmd.add("-cp");
        cmd.add(classpath);
        cmd.add(mainClass.getName());
        for (String arg : args) {
            cmd.add(arg);
        }
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        return pb;
    }

    // ----- Success path --------------------------------------------------------

    @Test
    public void runWithProcessManager_normalExit_registersAndUnregisters() throws Exception {
        ProcessBuilder pb = javaChild(TestChildEcho.class, "hello", "world");
        List<String> lines = new ArrayList<>();

        int exit = PromptEnhancerProcessRunner.runWithProcessManager(
                pb, pm, /* stdinJson */ "", 30, 5, lines::add);

        assertEquals("child should exit cleanly", 0, exit);
        assertTrue("should capture 'hello' line", lines.contains("hello"));
        assertTrue("should capture 'world' line", lines.contains("world"));

        // Register/unregister must be balanced and use the same channelId+process.
        assertEquals(1, pm.registerCalls.get());
        assertEquals(1, pm.unregisterCalls.get());
        assertEquals(pm.lastRegisteredChannelId.get(), pm.lastUnregisteredChannelId.get());
        assertSame(pm.registeredProcess.get(), pm.unregisteredProcess.get());

        // Channel ID convention — used by the Node Process panel to label entries.
        assertNotNull(pm.lastRegisteredChannelId.get());
        assertTrue("channelId should be prefixed",
                pm.lastRegisteredChannelId.get().startsWith("prompt-enhancer-"));

        // Process must be dead after the call returns — no leak.
        assertFalse("process must not outlive the call",
                pm.registeredProcess.get().isAlive());

        // ProcessManager's internal registry must be empty after a clean run.
        assertEquals("no lingering active processes", 0, pm.getActiveProcessCount());
    }

    // ----- Timeout path (the original bug) -------------------------------------

    @Test
    public void runWithProcessManager_hungProcess_isForceKilledAfterTimeout() throws Exception {
        // Child sleeps far longer than the 2s timeout. The original (buggy) code
        // would block forever here; the fix must kill it.
        ProcessBuilder pb = javaChild(TestChildSleep.class, "60000");

        long start = System.currentTimeMillis();
        try {
            PromptEnhancerProcessRunner.runWithProcessManager(
                    pb, pm, /* stdinJson */ "", 2, 1, line -> { });
            fail("Expected TimeoutException for hung child process");
        } catch (TimeoutException expected) {
            // expected
        }
        long elapsed = System.currentTimeMillis() - start;

        // We must NOT have waited the full 60s. Be generous on CI: under 30s.
        assertTrue("timeout must enforce wall-clock bound, actual elapsed=" + elapsed + "ms",
                elapsed < 30_000);

        // Even on the timeout path, the process must be unregistered and dead.
        assertEquals(1, pm.registerCalls.get());
        assertEquals("unregister must fire on timeout path too",
                1, pm.unregisterCalls.get());
        assertFalse("force-killed process must not be alive after the call",
                pm.registeredProcess.get().isAlive());
        assertEquals(0, pm.getActiveProcessCount());
    }

    // ----- Helper child main classes -------------------------------------------

    /** Prints each argument on its own stdout line and exits 0. */
    public static class TestChildEcho {
        public static void main(String[] args) {
            for (String a : args) {
                System.out.println(a);
            }
        }
    }

    /** Sleeps for {@code args[0]} milliseconds then exits 0. */
    public static class TestChildSleep {
        public static void main(String[] args) throws InterruptedException {
            long ms = Long.parseLong(args[0]);
            Thread.sleep(ms);
        }
    }
}

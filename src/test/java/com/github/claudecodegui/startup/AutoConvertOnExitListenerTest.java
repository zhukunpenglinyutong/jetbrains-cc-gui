package com.github.claudecodegui.startup;

import com.github.claudecodegui.handler.history.HistoryAutoConvertService;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Coverage for the bounded, observable wait that the IDE shutdown path performs on
 * the auto-conversion worker.
 *
 * <p>The listener's own seams ({@code isAutoConvertEnabled}, {@code createWorkerThread},
 * {@code getJoinTimeoutMs}, {@code awaitWorkerCompletion}) are overridden here, so
 * these tests need no IDE application and never read the developer's real config.
 * The conversion body is pointed at a {@link TemporaryFolder}, so the real
 * {@code ~/.claude/projects} is never touched either.
 */
public class AutoConvertOnExitListenerTest {

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @After
    public void clearInterruptFlag() {
        // A test that leaves the interrupt flag set would break every later test in
        // the shared worker thread.
        Thread.interrupted();
    }

    // ── happy path: worker finishes inside the timeout ─────────────────────

    @Test
    public void joinsWorkerUntilConversionActuallyCompleted() throws Exception {
        Path projectsDir = temporaryFolder.newFolder("projects-root").toPath();
        Path sessionFile = writeSession(projectsDir);
        TestListener listener = new TestListener();
        listener.projectsDir = projectsDir;
        listener.joinTimeoutMs = 10_000L;

        listener.appWillBeClosed(false);

        // The strongest available proof that join() really waited: without it this
        // assertion races the worker thread and fails intermittently.
        assertEquals("{\"type\":\"user\",\"entrypoint\":\"cli\"}",
                Files.readString(sessionFile, StandardCharsets.UTF_8).trim());
        assertTrue("join should report a completed worker", listener.awaitResult.get());
        assertFalse("the interrupt flag must stay clear on the normal path",
                Thread.currentThread().isInterrupted());
    }

    @Test
    public void optOutSkipsTheWorkerEntirely() {
        TestListener listener = new TestListener();
        listener.enabled = false;
        listener.joinTimeoutMs = 10_000L;

        listener.appWillBeClosed(false);

        assertNull("no conversion thread may be created when the setting is off",
                listener.startedWorkerName);
        assertFalse("the bounded wait must not even be attempted", listener.awaitInvoked.get());
    }

    // ── timeout path: worker outlives the budget ───────────────────────────

    @Test
    public void givesUpWhenWorkerOutlivesTheTimeout() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch started = new CountDownLatch(1);
        TestListener listener = new TestListener();
        listener.workerBody = () -> {
            started.countDown();
            try {
                release.await(30, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        };
        // The production budget, not a test-local one: this is the branch that decides
        // how long the EDT stays blocked while the IDE quits, so the test has to
        // exercise the value the IDE actually uses.
        long budgetMs = AutoConvertOnExitListener.CONVERSION_JOIN_TIMEOUT_MS;

        long startNanos = System.nanoTime();
        try {
            listener.appWillBeClosed(false);
            long elapsedMs = (System.nanoTime() - startNanos) / 1_000_000L;

            assertTrue(started.await(5, TimeUnit.SECONDS));
            assertFalse("a still-running worker must be reported as unfinished",
                    listener.awaitResult.get());
            // The point of the bound: the shutdown path returns instead of waiting
            // for the daemon thread. Generous margin so a slow CI machine cannot flake.
            assertTrue("shutdown waited " + elapsedMs + " ms, more than the " + budgetMs + " ms budget",
                    elapsedMs < budgetMs + 3_000L);
        } finally {
            release.countDown();
        }
    }

    @Test
    public void productionJoinBudgetStaysAtTwoSeconds() {
        // appWillBeClosed runs on the EDT, so the budget is a directly visible freeze
        // of the IDE window. Anything above two seconds reads as a hung IDE; anything
        // much below it starves the normal case of a few freshly written sessions.
        assertEquals(2_000L, new AutoConvertOnExitListener().getJoinTimeoutMs());
    }

    @Test
    public void timeoutLeavesTheWorkerRunningForTheNextStartToPickUp() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        TestListener listener = new TestListener();
        listener.workerBody = () -> awaitQuietly(release);
        listener.joinTimeoutMs = 100L;
        AtomicReference<Thread> workerRef = new AtomicReference<>();
        listener.onWorkerCreated = workerRef::set;

        listener.appWillBeClosed(false);

        // Abandoned, not cancelled: the daemon thread is simply not waited for any
        // more, and a truncated scan is resumed on the next IDE start.
        assertFalse(listener.awaitResult.get());
        assertTrue(workerRef.get().isAlive());
        release.countDown();
    }

    // ── interrupt path ─────────────────────────────────────────────────────

    @Test
    public void interruptIsSwallowedAndFlagRestored() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        Thread worker = new Thread(() -> awaitQuietly(release), "ccgui-test-hanging-worker");
        worker.setDaemon(true);
        worker.start();
        try {
            // join() throws immediately when the calling thread is already interrupted.
            Thread.currentThread().interrupt();

            boolean finished = new AutoConvertOnExitListener().awaitWorkerCompletion(worker, 60_000L);

            assertFalse("an interrupted wait is never a completed wait", finished);
            assertTrue("the interrupt flag must be restored for upstream handlers",
                    Thread.currentThread().isInterrupted());
        } finally {
            release.countDown();
        }
    }

    @Test
    public void appWillBeClosedDoesNotPropagateInterrupt() {
        CountDownLatch release = new CountDownLatch(1);
        TestListener listener = new TestListener();
        listener.workerBody = () -> awaitQuietly(release);
        listener.joinTimeoutMs = 60_000L;
        try {
            Thread.currentThread().interrupt();

            // Must return normally: throwing here would abort the IDE quit and show a
            // dialog the user can do nothing about.
            listener.appWillBeClosed(false);

            assertFalse(listener.awaitResult.get());
        } finally {
            release.countDown();
        }
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private Path writeSession(Path projectsDir) throws IOException {
        Path projectDir = projectsDir.resolve("proj");
        Files.createDirectories(projectDir);
        Path file = projectDir.resolve("session.jsonl");
        Files.writeString(file, "{\"type\":\"user\",\"entrypoint\":\"sdk-cli\"}\n", StandardCharsets.UTF_8);
        return file;
    }

    /**
     * Listener with every IDE-side dependency replaced: the setting read, the thread
     * factory, the timeout budget, and the result of the bounded wait.
     */
    private static final class TestListener extends AutoConvertOnExitListener {

        private boolean enabled = true;
        // Negative means "use the production budget", so a test that cares about the
        // real shutdown timing does not have to restate the constant.
        private long joinTimeoutMs = -1L;

        /** When set, replaces the real conversion with a body of known duration. */
        private Runnable workerBody;
        private Path projectsDir;

        private final AtomicBoolean awaitResult = new AtomicBoolean();
        private final AtomicBoolean awaitInvoked = new AtomicBoolean();
        private volatile String startedWorkerName;
        private volatile Consumer<Thread> onWorkerCreated;

        @Override
        boolean isAutoConvertEnabled() {
            return enabled;
        }

        @Override
        long getJoinTimeoutMs() {
            return joinTimeoutMs >= 0 ? joinTimeoutMs : super.getJoinTimeoutMs();
        }

        @Override
        Thread createWorkerThread() {
            Runnable body = workerBody != null
                    ? workerBody
                    : () -> new HistoryAutoConvertService(() -> projectsDir).convertAllProjects();
            Thread worker = new Thread(body, "ccgui-test-auto-convert");
            worker.setDaemon(true);
            startedWorkerName = worker.getName();
            if (onWorkerCreated != null) {
                onWorkerCreated.accept(worker);
            }
            return worker;
        }

        @Override
        boolean awaitWorkerCompletion(Thread worker, long timeoutMs) {
            awaitInvoked.set(true);
            boolean finished = super.awaitWorkerCompletion(worker, timeoutMs);
            awaitResult.set(finished);
            return finished;
        }
    }
}

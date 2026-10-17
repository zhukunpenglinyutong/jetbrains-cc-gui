package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Deterministic concurrency regression tests for {@link MessageDispatchGate}.
 *
 * <p>These pin down the lifecycle contract the gate restores after the lock-free dispatch was
 * reverted: dispatch and teardown serialize, teardown never deadlocks with an in-flight dispatch,
 * and no dispatch side effect can start once teardown has begun. Latches force the exact
 * interleavings the PR review called out - the race where a {@code send_message} dispatch could
 * schedule an async {@code session.send} after {@code dispose()} had already run process cleanup.
 *
 * <p>The gate is pure Java with no platform dependencies, so these tests run without constructing a
 * full {@code ClaudeChatWindow} (which needs a Project, JBCefBrowser, etc.). {@code ClaudeChatWindow}
 * delegates its dispatch/dispose exclusion to this gate, so the contract proven here is the one the
 * JCEF callback path relies on.
 */
public class MessageDispatchGateTest {

    /**
     * Teardown must not deadlock when a dispatch is in flight: {@code beginTeardown} blocks on the
     * gate monitor until the in-flight dispatch releases it, then proceeds. This is the
     * EDT&lt;-&gt;JCEF deadlock that the lock-free version was written to avoid - proven here not to
     * regress while still serializing dispatch against teardown.
     */
    @Test(timeout = 5000)
    public void teardownDoesNotDeadlockWithInFlightDispatch() throws Exception {
        MessageDispatchGate gate = new MessageDispatchGate();
        CountDownLatch dispatchEntered = new CountDownLatch(1);
        CountDownLatch releaseDispatch = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<?> dispatchFuture = executor.submit(() ->
                gate.runInDispatch(() -> {
                    dispatchEntered.countDown();
                    awaitUninterrupted(releaseDispatch);
                }));
            assertTrue("dispatch should enter the gate",
                    dispatchEntered.await(2, TimeUnit.SECONDS));

            Future<Boolean> teardownFuture = executor.submit(gate::beginTeardown);
            // Teardown is blocked behind the in-flight dispatch which holds the gate monitor.
            Thread.sleep(150);
            assertFalse("teardown must block while a dispatch is in flight",
                    teardownFuture.isDone());

            releaseDispatch.countDown();
            dispatchFuture.get(2, TimeUnit.SECONDS);
            assertTrue("teardown should complete once dispatch releases the gate",
                    teardownFuture.get(2, TimeUnit.SECONDS));
        } finally {
            executor.shutdownNow();
            executor.awaitTermination(2, TimeUnit.SECONDS);
        }
    }

    /**
     * Once teardown has begun, {@code runInDispatch} must refuse and the task must not run - no
     * handler side effect (e.g. scheduling an async {@code session.send}) can start after disposal.
     */
    @Test
    public void noDispatchSideEffectAfterTeardownBegun() {
        MessageDispatchGate gate = new MessageDispatchGate();
        AtomicBoolean ran = new AtomicBoolean(false);

        assertTrue("first teardown should flip the gate", gate.beginTeardown());
        assertFalse("a dispatch after teardown must be rejected",
                gate.runInDispatch(() -> ran.set(true)));
        assertFalse("the rejected task must not have executed", ran.get());
    }

    /**
     * {@code beginTeardown} is idempotent: a second call returns false without blocking, so a
     * repeated {@code dispose()} is a no-op.
     */
    @Test
    public void beginTeardownIsIdempotent() {
        MessageDispatchGate gate = new MessageDispatchGate();
        assertTrue(gate.beginTeardown());
        assertFalse(gate.beginTeardown());
        assertTrue(gate.isDisposed());
    }

    /**
     * The intended behavior for an already-in-flight dispatch is explicit: {@code beginTeardown}
     * does not return until the in-flight dispatch has finished, so teardown never overlaps a
     * handler. The dispatch body's completion flag must be visible by the time teardown returns.
     */
    @Test(timeout = 5000)
    public void inFlightDispatchCompletesBeforeTeardownReturns() throws Exception {
        MessageDispatchGate gate = new MessageDispatchGate();
        CountDownLatch dispatchEntered = new CountDownLatch(1);
        CountDownLatch releaseDispatch = new CountDownLatch(1);
        AtomicBoolean dispatchBodyFinished = new AtomicBoolean(false);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            executor.submit(() ->
                gate.runInDispatch(() -> {
                    dispatchEntered.countDown();
                    awaitUninterrupted(releaseDispatch);
                    dispatchBodyFinished.set(true);
                }));
            assertTrue(dispatchEntered.await(2, TimeUnit.SECONDS));

            Future<Boolean> teardownFuture = executor.submit(gate::beginTeardown);
            // Ensure teardown has started and is blocked on the gate monitor held by dispatch,
            // so the assertions below exercise "beginTeardown waits for in-flight dispatch"
            // rather than "dispatch finished before teardown started".
            Thread.sleep(150);
            assertFalse("teardown must block while dispatch holds the gate",
                    teardownFuture.isDone());
            releaseDispatch.countDown();
            assertTrue(teardownFuture.get(2, TimeUnit.SECONDS));
            assertTrue("dispatch body must finish before beginTeardown returns",
                    dispatchBodyFinished.get());
        } finally {
            executor.shutdownNow();
            executor.awaitTermination(2, TimeUnit.SECONDS);
        }
    }

    /**
     * A live gate runs the dispatch task and reports it ran.
     */
    @Test
    public void liveGateRunsDispatch() {
        MessageDispatchGate gate = new MessageDispatchGate();
        AtomicBoolean ran = new AtomicBoolean(false);
        assertTrue(gate.runInDispatch(() -> ran.set(true)));
        assertTrue(ran.get());
        assertFalse(gate.isDisposed());
    }

    /** Page publication must wait until every old-page handler has finished capturing its reply. */
    @Test(timeout = 5000)
    public void pageActivationWaitsForOldDispatchAndRejectsStaleMessages() throws Exception {
        MessageDispatchGate gate = new MessageDispatchGate();
        gate.activatePageGeneration(1);
        CountDownLatch dispatchEntered = new CountDownLatch(1);
        CountDownLatch releaseDispatch = new CountDownLatch(1);
        AtomicBoolean oldDispatchFinished = new AtomicBoolean();
        AtomicBoolean published = new AtomicBoolean();
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<Boolean> dispatchFuture = executor.submit(() ->
                    gate.runInDispatch(1, () -> {
                        dispatchEntered.countDown();
                        awaitUninterrupted(releaseDispatch);
                        assertFalse("page identity must stay old during the old dispatch", published.get());
                        oldDispatchFinished.set(true);
                    }));
            assertTrue(dispatchEntered.await(2, TimeUnit.SECONDS));

            Future<Boolean> activationFuture = executor.submit(() -> gate.activatePageGeneration(2, () -> {
                assertTrue("old dispatch must finish before publication starts", oldDispatchFinished.get());
                published.set(true);
            }));
            Thread.sleep(150);
            assertFalse("page activation must wait for old dispatch", activationFuture.isDone());
            assertFalse(published.get());

            releaseDispatch.countDown();
            assertTrue(dispatchFuture.get(2, TimeUnit.SECONDS));
            assertTrue(activationFuture.get(2, TimeUnit.SECONDS));
            assertTrue(published.get());

            assertFalse(gate.runInDispatch(1, () -> { }));
            assertTrue(gate.runInDispatch(2, () -> { }));
        } finally {
            releaseDispatch.countDown();
            executor.shutdownNow();
            executor.awaitTermination(2, TimeUnit.SECONDS);
        }
    }

    /** New-page handlers must not capture a page identity while publication is incomplete. */
    @Test(timeout = 5000)
    public void newPageDispatchWaitsForPublicationToFinish() throws Exception {
        MessageDispatchGate gate = new MessageDispatchGate();
        gate.activatePageGeneration(1);
        AtomicInteger publishedPage = new AtomicInteger(1);
        AtomicBoolean baselinesReset = new AtomicBoolean();
        AtomicBoolean dispatched = new AtomicBoolean();
        CountDownLatch publicationEntered = new CountDownLatch(1);
        CountDownLatch releasePublication = new CountDownLatch(1);
        CountDownLatch newDispatchStarted = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<Boolean> activation = executor.submit(() -> gate.activatePageGeneration(2, () -> {
                publicationEntered.countDown();
                awaitUninterrupted(releasePublication);
                publishedPage.set(2);
                baselinesReset.set(true);
            }));
            assertTrue(publicationEntered.await(2, TimeUnit.SECONDS));
            Future<Boolean> newDispatch = executor.submit(() -> {
                newDispatchStarted.countDown();
                return gate.runInDispatch(2, () -> {
                    assertEquals(2, publishedPage.get());
                    assertTrue("delivery baselines must be reset before dispatch", baselinesReset.get());
                    dispatched.set(true);
                });
            });
            assertTrue(newDispatchStarted.await(2, TimeUnit.SECONDS));
            try {
                newDispatch.get(150, TimeUnit.MILLISECONDS);
                org.junit.Assert.fail("new-page dispatch must wait for the complete publication");
            } catch (TimeoutException expected) {
                assertFalse(dispatched.get());
                assertEquals(1, publishedPage.get());
            }

            releasePublication.countDown();
            assertTrue(activation.get(2, TimeUnit.SECONDS));
            assertTrue(newDispatch.get(2, TimeUnit.SECONDS));
            assertTrue(dispatched.get());
        } finally {
            releasePublication.countDown();
            executor.shutdownNow();
            executor.awaitTermination(2, TimeUnit.SECONDS);
        }
    }

    /** Teardown must prevent both generation activation and its owner's publication callback. */
    @Test
    public void disposedGateRejectsPagePublication() {
        MessageDispatchGate gate = new MessageDispatchGate();
        AtomicBoolean published = new AtomicBoolean();
        gate.beginTeardown();

        assertFalse(gate.activatePageGeneration(2, () -> published.set(true)));
        assertFalse(published.get());
    }

    private static void awaitUninterrupted(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}

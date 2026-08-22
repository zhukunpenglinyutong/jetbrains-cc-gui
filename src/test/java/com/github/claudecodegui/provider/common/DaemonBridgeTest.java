package com.github.claudecodegui.provider.common;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Verifies cross-platform daemon heartbeat/probe timing, generation-scoped
 * ownership including stderr eligibility, and cancellable start/stop lifecycle
 * transitions.
 */
public class DaemonBridgeTest {

    // HEARTBEAT_TIMEOUT_MS = 45_000; just over threshold triggers unresponsive
    private static final long JUST_OVER_HEARTBEAT_THRESHOLD = 46_000;
    // ACTIVE_REQUEST_HEARTBEAT_TIMEOUT_MS = 180_000; well over for active-request timeout
    private static final long OVER_ACTIVE_REQUEST_THRESHOLD = 190_000;
    // Recent activity within threshold
    private static final long RECENT_ACTIVITY = 5_000;

    /** Verifies that an idle daemon beyond the base timeout is considered stale. */
    @Test
    public void staleHeartbeatWithoutActiveRequestsIsUnresponsive() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(JUST_OVER_HEARTBEAT_THRESHOLD, JUST_OVER_HEARTBEAT_THRESHOLD, 0));
    }

    /** Verifies that recent request output keeps an active daemon alive. */
    @Test
    public void activeRequestWithRecentOutputGetsGraceWindow() {
        assertFalse(DaemonBridge.shouldTreatAsUnresponsive(JUST_OVER_HEARTBEAT_THRESHOLD, RECENT_ACTIVITY, 1));
    }

    /** Verifies that an active daemon is eventually stale when all activity stops. */
    @Test
    public void activeRequestWithNoRecentOutputEventuallyTimesOut() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(OVER_ACTIVE_REQUEST_THRESHOLD, OVER_ACTIVE_REQUEST_THRESHOLD, 1));
    }

    /**
     * Regression test for issue #1512: after a daemon restart the heartbeat
     * baseline is reset, so a fresh heartbeat age must NOT be flagged as
     * unresponsive even when there are no active requests.
     */
    @Test
    public void freshHeartbeatAfterRestartIsNotUnresponsive() {
        assertFalse(DaemonBridge.shouldTreatAsUnresponsive(RECENT_ACTIVITY, RECENT_ACTIVITY, 0));
    }

    /**
     * Documents the exact restart-storm scenario from issue #1512: a stale
     * heartbeat age (left over from the previous dead process) combined with
     * a fresh activity age and no active requests IS treated as unresponsive.
     * A generation context prevents this stale combination from crossing a
     * restart by owning and initializing both heartbeat clocks independently.
     */
    @Test
    public void staleHeartbeatWithFreshActivityIsUnresponsive() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(297_132, 149, 0));
    }

    /**
     * Verifies a stderr reader records only for the current active generation,
     * rejecting both a replaced generation and a generation that has stopped.
     */
    @Test
    public void stderrReaderRejectsStoppedAndReplacedGenerations() {
        DaemonBridge.DaemonGenerationContext sourceContext = newContext(1);
        DaemonBridge.DaemonGenerationContext replacementContext = newContext(2);

        assertTrue(DaemonBridge.shouldRecordStderrLine(sourceContext, sourceContext));
        assertFalse(DaemonBridge.shouldRecordStderrLine(replacementContext, sourceContext));

        sourceContext.stop();
        assertFalse(DaemonBridge.shouldRecordStderrLine(sourceContext, sourceContext));
    }

    /** Verifies that the first stale observation sends a probe instead of killing the daemon. */
    @Test
    public void firstStaleObservationRequestsHeartbeatProbe() {
        MutableTimeSource timeSource = new MutableTimeSource(46_000, nanos(46_000));
        DaemonBridge.HeartbeatTimestamps timestamps = timestampsAtZero();
        DaemonBridge.IdleHeartbeatProbeState state = new DaemonBridge.IdleHeartbeatProbeState();
        state.reset(30_000);

        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));
    }

    /** Verifies idle wake probes immediately when nanoTime pauses during suspend. */
    @Test
    public void idleWakeWithPausedMonotonicClockStillSendsProbe() {
        MutableTimeSource timeSource = new MutableTimeSource(0, nanos(0));
        DaemonBridge.HeartbeatTimestamps timestamps = timestampsAtZero();
        DaemonBridge.IdleHeartbeatProbeState state = new DaemonBridge.IdleHeartbeatProbeState();
        state.reset(0);

        timeSource.set(300_000, nanos(15_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));

        timeSource.set(305_000, nanos(20_000));
        timestamps.markHeartbeat(timeSource);
        assertEquals(
                DaemonBridge.HeartbeatDecision.HEALTHY,
                evaluate(state, timeSource, timestamps, 0));
    }

    /** Verifies idle wake has the same probe policy when nanoTime includes suspend. */
    @Test
    public void idleWakeWithAdvancingMonotonicClockAlsoSendsProbe() {
        MutableTimeSource timeSource = new MutableTimeSource(0, nanos(0));
        DaemonBridge.HeartbeatTimestamps timestamps = timestampsAtZero();
        DaemonBridge.IdleHeartbeatProbeState state = new DaemonBridge.IdleHeartbeatProbeState();
        state.reset(0);

        timeSource.set(300_000, nanos(300_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));
    }

    /** Verifies a wake probe cannot succeed without a response when nanoTime paused. */
    @Test
    public void pausedMonotonicWakeWithoutResponseExpiresProbe() {
        MutableTimeSource timeSource = new MutableTimeSource(0, nanos(0));
        DaemonBridge.HeartbeatTimestamps timestamps = timestampsAtZero();
        DaemonBridge.IdleHeartbeatProbeState state = new DaemonBridge.IdleHeartbeatProbeState();
        state.reset(0);

        timeSource.set(300_000, nanos(15_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));
        timeSource.set(315_000, nanos(30_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.WAIT_FOR_PROBE,
                evaluate(state, timeSource, timestamps, 0));
        timeSource.set(330_000, nanos(45_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.DECLARE_DEAD,
                evaluate(state, timeSource, timestamps, 0));
    }

    /** Verifies a wake probe also expires without a response when nanoTime advanced. */
    @Test
    public void advancingMonotonicWakeWithoutResponseExpiresProbe() {
        MutableTimeSource timeSource = new MutableTimeSource(0, nanos(0));
        DaemonBridge.HeartbeatTimestamps timestamps = timestampsAtZero();
        DaemonBridge.IdleHeartbeatProbeState state = new DaemonBridge.IdleHeartbeatProbeState();
        state.reset(0);

        timeSource.set(300_000, nanos(300_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));
        timeSource.set(315_000, nanos(315_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.WAIT_FOR_PROBE,
                evaluate(state, timeSource, timestamps, 0));
        timeSource.set(330_000, nanos(330_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.DECLARE_DEAD,
                evaluate(state, timeSource, timestamps, 0));
    }

    /** Verifies active requests use wall age consistently when nanoTime pauses in sleep. */
    @Test
    public void activeRequestAfterSystemSleepKeepsExistingTimeoutSemantics() {
        MutableTimeSource timeSource = new MutableTimeSource(300_000, nanos(15_000));
        DaemonBridge.HeartbeatTimestamps timestamps = timestampsAtZero();
        DaemonBridge.IdleHeartbeatProbeState state = new DaemonBridge.IdleHeartbeatProbeState();
        state.reset(0);

        assertEquals(
                DaemonBridge.HeartbeatDecision.DECLARE_DEAD,
                evaluate(state, timeSource, timestamps, 1));

        timeSource.set(305_000, nanos(20_000));
        timestamps.markHeartbeat(timeSource);
        assertEquals(
                DaemonBridge.HeartbeatDecision.HEALTHY,
                evaluate(state, timeSource, timestamps, 1));
    }

    /** Verifies active suspend timeout is identical when nanoTime includes the sleep. */
    @Test
    public void activeRequestWithAdvancingMonotonicClockUsesSameWallTimeout() {
        MutableTimeSource timeSource = new MutableTimeSource(300_000, nanos(300_000));
        DaemonBridge.HeartbeatTimestamps timestamps = timestampsAtZero();
        DaemonBridge.IdleHeartbeatProbeState state = new DaemonBridge.IdleHeartbeatProbeState();
        state.reset(0);

        assertEquals(
                DaemonBridge.HeartbeatDecision.DECLARE_DEAD,
                evaluate(state, timeSource, timestamps, 1));
    }

    /** Verifies that a stale daemon is declared dead only after the bounded probe expires. */
    @Test
    public void unansweredProbeEventuallyDeclaresDaemonDead() {
        MutableTimeSource timeSource = new MutableTimeSource(46_000, nanos(46_000));
        DaemonBridge.HeartbeatTimestamps timestamps = timestampsAtZero();
        DaemonBridge.IdleHeartbeatProbeState state = new DaemonBridge.IdleHeartbeatProbeState();
        state.reset(30_000);
        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));

        timeSource.set(61_000, nanos(61_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.WAIT_FOR_PROBE,
                evaluate(state, timeSource, timestamps, 0));
        timeSource.set(76_000, nanos(76_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.DECLARE_DEAD,
                evaluate(state, timeSource, timestamps, 0));
    }

    /** Verifies that a heartbeat response clears the outstanding probe state. */
    @Test
    public void heartbeatResponseClearsOutstandingProbe() {
        MutableTimeSource timeSource = new MutableTimeSource(46_000, nanos(46_000));
        DaemonBridge.HeartbeatTimestamps timestamps = timestampsAtZero();
        DaemonBridge.IdleHeartbeatProbeState state = new DaemonBridge.IdleHeartbeatProbeState();
        state.reset(30_000);
        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));

        timeSource.set(51_000, nanos(51_000));
        timestamps.markHeartbeat(timeSource);
        assertEquals(
                DaemonBridge.HeartbeatDecision.HEALTHY,
                evaluate(state, timeSource, timestamps, 0));
        timeSource.set(97_000, nanos(97_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));
    }

    /**
     * Verifies that a sleep-sized scheduler gap replaces an old probe instead
     * of treating its elapsed wall-clock time as a failed liveness check.
     */
    @Test
    public void schedulerGapRearmsProbeWithoutKillingHealthyDaemon() {
        MutableTimeSource timeSource = new MutableTimeSource(46_000, nanos(46_000));
        DaemonBridge.HeartbeatTimestamps timestamps = timestampsAtZero();
        DaemonBridge.IdleHeartbeatProbeState state = new DaemonBridge.IdleHeartbeatProbeState();
        state.reset(30_000);
        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));

        timeSource.set(346_000, nanos(51_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));
        timeSource.set(351_000, nanos(56_000));
        timestamps.markHeartbeat(timeSource);
        assertEquals(
                DaemonBridge.HeartbeatDecision.HEALTHY,
                evaluate(state, timeSource, timestamps, 0));
    }

    /** Verifies a wall-clock rollback rearms the idle probe without expiring it. */
    @Test
    public void wallClockRollbackRearmsProbeUsingMonotonicDeadline() {
        MutableTimeSource timeSource = new MutableTimeSource(25_000, nanos(46_000));
        DaemonBridge.HeartbeatTimestamps timestamps = timestampsAtZero();
        DaemonBridge.IdleHeartbeatProbeState state = new DaemonBridge.IdleHeartbeatProbeState();
        state.reset(10_000);
        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));

        timeSource.set(5_000, nanos(61_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));
    }

    /** Verifies a negative nanoTime value can still own an active probe deadline. */
    @Test
    public void negativeMonotonicValueDoesNotCollideWithProbeState() {
        MutableTimeSource timeSource = new MutableTimeSource(46_000, -nanos(1_000));
        DaemonBridge.HeartbeatTimestamps timestamps =
                new DaemonBridge.HeartbeatTimestamps(0, -nanos(50_000));
        DaemonBridge.IdleHeartbeatProbeState state = new DaemonBridge.IdleHeartbeatProbeState();
        state.reset(30_000);

        assertEquals(
                DaemonBridge.HeartbeatDecision.SEND_PROBE,
                evaluate(state, timeSource, timestamps, 0));
        timeSource.set(61_000, nanos(14_000));
        assertEquals(
                DaemonBridge.HeartbeatDecision.WAIT_FOR_PROBE,
                evaluate(state, timeSource, timestamps, 0));
    }

    /** Verifies a death claim revokes all subsequent output eligibility for its generation. */
    @Test
    public void claimedGenerationCannotBecomeActiveAgain() {
        DaemonBridge.DaemonGenerationContext context = newContext(1);

        assertTrue(context.isActive());
        context.claimDeath();
        assertFalse(context.isActive());
    }

    /** Verifies a late ready event cannot release or mutate the replacement generation. */
    @Test
    public void claimedGenerationRejectsLateReadyForReplacement() {
        DaemonBridge.DaemonGenerationContext claimed = newContext(1);
        DaemonBridge.DaemonGenerationContext replacement = newContext(2);
        claimed.claimDeath();

        assertFalse(claimed.signalReady(true));
        assertEquals(1, claimed.readySignalsRemaining());
        assertEquals(1, replacement.readySignalsRemaining());
        assertFalse(replacement.isSdkPreloaded());
    }

    /** Verifies cleanup of one generation cannot remove a replacement request. */
    @Test
    public void generationScopedRequestCleanupCannotClearReplacementRequests() {
        MutableTimeSource timeSource = new MutableTimeSource(0, nanos(0));
        DaemonBridge.DaemonGenerationContext claimed = newContext(1);
        DaemonBridge.DaemonGenerationContext replacement = newContext(2);
        DaemonBridge.RequestHandler oldHandler = newRequestHandler();
        DaemonBridge.RequestHandler newHandler = newRequestHandler();

        assertTrue(claimed.registerRequest("old", oldHandler, true, timeSource));
        claimed.claimDeath();
        assertEquals(1, claimed.drainRequests().size());
        assertFalse(claimed.registerRequest("late", oldHandler, true, timeSource));

        assertTrue(replacement.registerRequest("new", newHandler, true, timeSource));
        assertTrue(claimed.drainRequests().isEmpty());
        assertSame(newHandler, replacement.getRequestHandler("new"));
    }

    /** Verifies a heartbeat arriving after timeout observation cancels the death claim. */
    @Test
    public void heartbeatProgressInvalidatesPendingTimeoutObservation() {
        MutableTimeSource timeSource = new MutableTimeSource(300_000, nanos(300_000));
        DaemonBridge.DaemonGenerationContext context = newContext(1);
        DaemonBridge.HeartbeatObservation observation =
                context.captureHeartbeatObservation(timeSource);

        assertTrue(context.matchesTimeoutObservation(observation));
        timeSource.set(301_000, nanos(301_000));
        context.markHeartbeat(timeSource);
        assertFalse(context.matchesTimeoutObservation(observation));
        assertTrue(context.isActive());
    }

    /** Verifies a cancelled timeout keeps the heartbeat watchdog loop running. */
    @Test
    public void cancelledTimeoutContinuesHeartbeatMonitoring() {
        assertTrue(DaemonBridge.shouldContinueHeartbeatAfterDeath(
                DaemonBridge.DeathHandlingResult.CANCELLED));
        assertFalse(DaemonBridge.shouldContinueHeartbeatAfterDeath(
                DaemonBridge.DeathHandlingResult.CLAIMED));
        assertFalse(DaemonBridge.shouldContinueHeartbeatAfterDeath(
                DaemonBridge.DeathHandlingResult.STALE_GENERATION));
    }

    /** Verifies a later explicit stop epoch vetoes an already prepared auto-restart. */
    @Test
    public void explicitStopEpochCancelsPreparedAutomaticRestart() {
        DaemonBridge.DaemonGenerationContext claimed = newContext(1);
        claimed.claimDeath();

        assertTrue(DaemonBridge.shouldAutoRestart(
                true, 4, 4, claimed, claimed, 1));
        assertFalse(DaemonBridge.shouldAutoRestart(
                false, 5, 4, claimed, claimed, 1));
        assertFalse(DaemonBridge.shouldAutoRestart(
                true, 5, 4, claimed, claimed, 1));
    }

    /** Verifies a concurrent explicit stop prevents the claimed daemon from launching B. */
    @Test
    public void stopDuringDeathCleanupPreventsAutomaticReplacementProcess() throws Exception {
        MutableTimeSource timeSource = new MutableTimeSource(0, nanos(0));
        ControlledProcess firstProcess = new ControlledProcess(101);
        ControlledProcess replacementProcess = new ControlledProcess(102);
        firstProcess.emitReady();
        replacementProcess.emitReady();
        AtomicInteger launchCount = new AtomicInteger();
        CountDownLatch beforeRestartCheck = new CountDownLatch(1);
        CountDownLatch allowRestartCheck = new CountDownLatch(1);
        CountDownLatch restartCheckFinished = new CountDownLatch(1);
        DaemonBridge.DaemonLifecycleHooks hooks = new DaemonBridge.DaemonLifecycleHooks() {
            @Override
            public void beforeAutoRestartCheck(long generation) {
                beforeRestartCheck.countDown();
                await(allowRestartCheck);
            }

            @Override
            public void afterAutoRestartCheck(long generation) {
                restartCheckFinished.countDown();
            }
        };
        DaemonBridge bridge = new DaemonBridge(
                null,
                null,
                null,
                timeSource,
                () -> launchCount.getAndIncrement() == 0 ? firstProcess : replacementProcess,
                hooks);

        assertTrue(bridge.start());
        firstProcess.exit();
        assertTrue(beforeRestartCheck.await(2, TimeUnit.SECONDS));

        Thread stopThread = new Thread(bridge::stop, "DaemonBridgeTest-Stop");
        stopThread.start();
        assertTrue(firstProcess.stdinFlushed.await(2, TimeUnit.SECONDS));
        allowRestartCheck.countDown();
        stopThread.join(2_000);

        assertTrue(restartCheckFinished.await(2, TimeUnit.SECONDS));
        assertEquals(1, launchCount.get());
        assertFalse(replacementProcess.wasDestroyed());
        assertFalse(bridge.isAlive());
    }

    /**
     * Verifies a published dead generation retains the lifecycle slot and the
     * watchdog claims it even while the stdout reader remains blocked.
     */
    @Test
    public void deadPublishedGenerationIsNotOverwrittenBeforeReaderCleanup() throws Exception {
        MutableTimeSource timeSource = new MutableTimeSource(0, nanos(0));
        ControlledProcess firstProcess = new ControlledProcess(151);
        ControlledProcess replacementProcess = new ControlledProcess(152);
        firstProcess.emitReady();
        replacementProcess.emitReady();
        AtomicInteger launchCount = new AtomicInteger();
        CountDownLatch replacementLaunch = new CountDownLatch(1);
        CountDownLatch heartbeatCheckReached = new CountDownLatch(1);
        CountDownLatch allowHeartbeatCheck = new CountDownLatch(1);
        DaemonBridge.DaemonLifecycleHooks hooks = new DaemonBridge.DaemonLifecycleHooks() {
            @Override
            public void beforeHeartbeatCheck(long generation) {
                if (generation == 1) {
                    heartbeatCheckReached.countDown();
                    await(allowHeartbeatCheck);
                }
            }
        };
        DaemonBridge bridge = new DaemonBridge(
                null,
                null,
                null,
                timeSource,
                () -> {
                    if (launchCount.getAndIncrement() == 0) {
                        return firstProcess;
                    }
                    replacementLaunch.countDown();
                    return replacementProcess;
                },
                hooks,
                5,
                null);

        assertTrue(bridge.start());
        assertTrue(heartbeatCheckReached.await(2, TimeUnit.SECONDS));
        CompletableFuture<Boolean> oldFuture = bridge.sendCommand(
                "claude.send", new JsonObject(), new NoOpDaemonOutputCallback());
        firstProcess.markDeadWithoutClosingOutput();

        assertFalse(bridge.start());
        assertEquals(1, launchCount.get());
        assertFalse(oldFuture.isDone());

        allowHeartbeatCheck.countDown();
        assertTrue(replacementLaunch.await(2, TimeUnit.SECONDS));
        assertTrue(oldFuture.handle((value, error) -> error != null)
                .get(2, TimeUnit.SECONDS));
        assertTrue(bridge.start());
        assertEquals(2, launchCount.get());
        assertTrue(bridge.isAlive());
        firstProcess.closeOutput();
        bridge.stop();
    }

    /**
     * Verifies a daemon that exits before its initial ready signal cannot start
     * an ownerless replacement after {@link DaemonBridge#start()} returns false.
     */
    @Test
    public void readyFailureDoesNotLaunchBackgroundReplacement() throws Exception {
        MutableTimeSource timeSource = new MutableTimeSource(0, nanos(0));
        ControlledProcess failedProcess = new ControlledProcess(201);
        ControlledProcess replacementProcess = new ControlledProcess(202);
        failedProcess.exit();
        replacementProcess.emitReady();
        AtomicInteger launchCount = new AtomicInteger();
        CountDownLatch replacementLaunch = new CountDownLatch(1);
        DaemonBridge bridge = new DaemonBridge(
                null,
                null,
                null,
                timeSource,
                () -> {
                    if (launchCount.getAndIncrement() == 0) {
                        return failedProcess;
                    }
                    replacementLaunch.countDown();
                    return replacementProcess;
                },
                null);

        assertFalse(bridge.start());
        assertFalse(replacementLaunch.await(500, TimeUnit.MILLISECONDS));
        assertEquals(1, launchCount.get());
        assertFalse(bridge.isAlive());
        assertFalse(replacementProcess.wasDestroyed());
    }

    /**
     * Verifies stop can cancel a daemon waiting for ready without waiting for
     * the full daemon startup timeout or leaving the launched process alive.
     */
    @Test
    public void stopCancelsStartingDaemonWithoutWaitingForReadyTimeout() throws Exception {
        MutableTimeSource timeSource = new MutableTimeSource(0, nanos(0));
        ControlledProcess startingProcess = new ControlledProcess(301);
        CountDownLatch processLaunchEntered = new CountDownLatch(1);
        AtomicBoolean startResult = new AtomicBoolean(true);
        DaemonBridge bridge = new DaemonBridge(
                null,
                null,
                null,
                timeSource,
                () -> {
                    processLaunchEntered.countDown();
                    return startingProcess;
                },
                null);
        Thread startThread = new Thread(
                () -> startResult.set(bridge.start()), "DaemonBridgeTest-Start");
        startThread.start();
        assertTrue(processLaunchEntered.await(2, TimeUnit.SECONDS));

        Thread stopThread = new Thread(bridge::stop, "DaemonBridgeTest-StopStarting");
        stopThread.start();
        stopThread.join(2_000);
        startThread.join(2_000);

        assertFalse("stop() must not wait for the 30-second ready timeout", stopThread.isAlive());
        assertFalse("start() must observe the cancelled attempt", startThread.isAlive());
        assertFalse(startResult.get());
        assertTrue(startingProcess.wasDestroyed());
        assertFalse(bridge.isAlive());
    }

    private static DaemonBridge.HeartbeatTimestamps timestampsAtZero() {
        return new DaemonBridge.HeartbeatTimestamps(0, nanos(0));
    }

    private static DaemonBridge.HeartbeatDecision evaluate(
            DaemonBridge.IdleHeartbeatProbeState state,
            DaemonBridge.TimeSource timeSource,
            DaemonBridge.HeartbeatTimestamps timestamps,
            int activeRequestCount
    ) {
        return state.evaluate(timestamps.snapshot(timeSource, activeRequestCount));
    }

    private static DaemonBridge.DaemonGenerationContext newContext(long generation) {
        StubProcess process = new StubProcess();
        return new DaemonBridge.DaemonGenerationContext(
                process,
                new java.io.BufferedWriter(new java.io.OutputStreamWriter(process.getOutputStream())),
                generation,
                0,
                nanos(0));
    }

    private static DaemonBridge.RequestHandler newRequestHandler() {
        return new DaemonBridge.RequestHandler(
                new NoOpDaemonOutputCallback(), new CompletableFuture<>());
    }

    private static long nanos(long millis) {
        return TimeUnit.MILLISECONDS.toNanos(millis);
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await(2, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Mutable dual clock used to reproduce platform-specific suspend behavior. */
    private static final class MutableTimeSource implements DaemonBridge.TimeSource {
        private long wallTimeMs;
        private long nanoTime;

        private MutableTimeSource(long wallTimeMs, long nanoTime) {
            set(wallTimeMs, nanoTime);
        }

        private void set(long wallTimeMs, long nanoTime) {
            this.wallTimeMs = wallTimeMs;
            this.nanoTime = nanoTime;
        }

        @Override
        public long currentTimeMillis() {
            return wallTimeMs;
        }

        @Override
        public long nanoTime() {
            return nanoTime;
        }
    }

    /** No-op callback used to test request ownership without invoking provider logic. */
    private static final class NoOpDaemonOutputCallback implements DaemonBridge.DaemonOutputCallback {
        @Override
        public void onLine(String line) {
            // No-op.
        }

        @Override
        public void onStderr(String text) {
            // No-op.
        }

        @Override
        public void onError(String error) {
            // No-op.
        }

        @Override
        public void onComplete(boolean success) {
            // No-op.
        }
    }

    /** Minimal process identity used to test generation ownership without starting an OS process. */
    private static final class StubProcess extends Process {
        @Override
        public OutputStream getOutputStream() {
            return new ByteArrayOutputStream();
        }

        @Override
        public InputStream getInputStream() {
            return new ByteArrayInputStream(new byte[0]);
        }

        @Override
        public InputStream getErrorStream() {
            return new ByteArrayInputStream(new byte[0]);
        }

        @Override
        public int waitFor() {
            return 0;
        }

        @Override
        public int exitValue() {
            return 0;
        }

        @Override
        public void destroy() {
            // No-op test process.
        }
    }

    /** Controllable process used to drive the real reader/death/stop lifecycle deterministically. */
    private static final class ControlledProcess extends Process {
        private final long processId;
        private final PipedInputStream stdout = new PipedInputStream();
        private final PipedOutputStream stdoutWriter;
        private final AtomicBoolean alive = new AtomicBoolean(true);
        private final AtomicBoolean destroyed = new AtomicBoolean(false);
        private final CountDownLatch stdinFlushed = new CountDownLatch(1);
        private final OutputStream stdin = new ByteArrayOutputStream() {
            @Override
            public void flush() {
                stdinFlushed.countDown();
            }
        };

        private ControlledProcess(long processId) throws java.io.IOException {
            this.processId = processId;
            this.stdoutWriter = new PipedOutputStream(stdout);
        }

        private void emitReady() throws java.io.IOException {
            stdoutWriter.write(("{\"type\":\"daemon\",\"event\":\"ready\","
                    + "\"sdkPreloaded\":true}\n").getBytes(StandardCharsets.UTF_8));
            stdoutWriter.flush();
        }

        private void exit() throws java.io.IOException {
            markDeadWithoutClosingOutput();
            closeOutput();
        }

        private void markDeadWithoutClosingOutput() {
            alive.set(false);
        }

        private void closeOutput() throws java.io.IOException {
            stdoutWriter.close();
        }

        private boolean wasDestroyed() {
            return destroyed.get();
        }

        @Override
        public OutputStream getOutputStream() {
            return stdin;
        }

        @Override
        public InputStream getInputStream() {
            return stdout;
        }

        @Override
        public InputStream getErrorStream() {
            return new ByteArrayInputStream(new byte[0]);
        }

        @Override
        public int waitFor() {
            return 0;
        }

        @Override
        public int exitValue() {
            return 0;
        }

        @Override
        public void destroy() {
            destroyed.set(true);
            alive.set(false);
        }

        @Override
        public Process destroyForcibly() {
            destroy();
            return this;
        }

        @Override
        public boolean isAlive() {
            return alive.get();
        }

        @Override
        public long pid() {
            return processId;
        }
    }
}

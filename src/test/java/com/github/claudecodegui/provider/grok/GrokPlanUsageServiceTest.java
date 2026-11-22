package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;

public class GrokPlanUsageServiceTest {

    private static class FakeGrokBridge extends GrokSDKBridge {
        final AtomicInteger callCount = new AtomicInteger();
        volatile JsonObject responseToReturn;
        volatile Throwable errorToThrow;
        volatile CompletableFuture<JsonObject> blocked;
        /** Runs inside each call, e.g. to move a test clock past an RPC timeout. */
        volatile Runnable onCall;

        FakeGrokBridge(JsonObject initialResponse) {
            this.responseToReturn = initialResponse;
        }

        @Override
        public CompletableFuture<JsonObject> getPlanUsage(String cwd) {
            callCount.incrementAndGet();
            if (onCall != null) {
                onCall.run();
            }
            if (blocked != null) {
                return blocked;
            }
            if (errorToThrow != null) {
                CompletableFuture<JsonObject> future = new CompletableFuture<>();
                future.completeExceptionally(errorToThrow);
                return future;
            }
            return CompletableFuture.completedFuture(responseToReturn);
        }
    }

    private static JsonObject makePayload(boolean present) {
        JsonObject obj = new JsonObject();
        obj.addProperty("present", present);
        obj.addProperty("provider", "grok");
        obj.addProperty("source", "x.ai/billing");
        if (present) {
            obj.addProperty("capacity_pct", 50.0);
        } else {
            obj.addProperty("unavailable", true);
            obj.addProperty("message", "Grok usage unavailable");
        }
        return obj;
    }

    @Before
    public void setUp() {
        GrokPlanUsageService.resetCacheForTests();
    }

    @After
    public void tearDown() {
        GrokPlanUsageService.resetCacheForTests();
    }

    private static void assertStalePercent(JsonObject payload) {
        assertTrue(payload.get("present").getAsBoolean());
        assertTrue(payload.get("stale").getAsBoolean());
        assertEquals(50.0, payload.get("capacity_pct").getAsDouble(), 0.0);
    }

    private static void assertHidden(JsonObject payload) {
        assertFalse(payload.get("present").getAsBoolean());
        assertFalse(payload.has("stale"));
        assertFalse(payload.has("capacity_pct"));
    }

    @Test
    public void testFailureLadderAndCacheSuppression() {
        long t = 1_000_000L;
        FakeGrokBridge bridge = new FakeGrokBridge(makePayload(true));

        // 1. Present result: suppresses a second call at +60s (FRESH_MS = 115_000)
        JsonObject r1 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t);
        assertTrue(r1.get("present").getAsBoolean());
        assertEquals(1, bridge.callCount.get());

        // +60s later: should be cached
        JsonObject r2 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + 60_000L);
        assertTrue(r2.get("present").getAsBoolean());
        assertEquals(1, bridge.callCount.get());

        // 2. Next call at +115s (freshness expired): failure keeps the percent while it is young
        bridge.responseToReturn = makePayload(false);
        JsonObject r3 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + 115_000L);
        assertStalePercent(r3);
        assertEquals(2, bridge.callCount.get());

        // A failure suppresses a call at +19s (step 0: 20_000ms) and still serves the stale percent
        JsonObject r4 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + 115_000L + 19_000L);
        assertStalePercent(r4);
        assertEquals(2, bridge.callCount.get());

        // and allows it at +20s
        long tFailure1Resolved = t + 115_000L + 20_000L;
        JsonObject r5 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFailure1Resolved);
        assertStalePercent(r5);
        assertEquals(3, bridge.callCount.get());

        // Next gap is 60s (step 1: 60_000ms ttl)
        // Suppresses at +59s
        JsonObject r6 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFailure1Resolved + 59_000L);
        assertStalePercent(r6);
        assertEquals(3, bridge.callCount.get());

        // Allows at +60s
        long tFailure2Resolved = tFailure1Resolved + 60_000L;
        JsonObject r7 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFailure2Resolved);
        assertStalePercent(r7);
        assertEquals(4, bridge.callCount.get());

        // Next gap is 5 minutes (step 2: 300_000ms ttl)
        // Suppresses at +299s
        JsonObject r8 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFailure2Resolved + 299_000L);
        assertStalePercent(r8);
        assertEquals(4, bridge.callCount.get());

        // Allows at +300s (5m)
        long tFailure3Resolved = tFailure2Resolved + 300_000L;
        JsonObject r9 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFailure3Resolved);
        assertStalePercent(r9);
        assertEquals(5, bridge.callCount.get());

        // Next gap is 30 minutes (step 3: 1_800_000ms ttl). Age is past STALE_MAX_MS (~t + 2_294s).
        // Suppresses at +1799s
        JsonObject r10 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFailure3Resolved + 1_799_000L);
        assertHidden(r10);
        assertEquals(5, bridge.callCount.get());

        // Allows at +1800s (30m)
        long tFailure4Resolved = tFailure3Resolved + 1_800_000L;
        JsonObject r11 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFailure4Resolved);
        assertHidden(r11);
        assertEquals(6, bridge.callCount.get());

        // 3. A later present result resets the ladder
        bridge.responseToReturn = makePayload(true);
        long tSuccess = tFailure4Resolved + 1_800_000L;
        JsonObject r12 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tSuccess);
        assertTrue(r12.get("present").getAsBoolean());
        assertEquals(7, bridge.callCount.get());

        // 4. The following failure waits 20s again
        bridge.responseToReturn = makePayload(false);
        long tAfterSuccess = tSuccess + 115_000L;
        JsonObject r13 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tAfterSuccess);
        assertStalePercent(r13);
        assertEquals(8, bridge.callCount.get());

        // Suppresses at +19s and still serves the stale percent
        JsonObject suppressed = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tAfterSuccess + 19_000L);
        assertStalePercent(suppressed);
        assertEquals(8, bridge.callCount.get());

        // Allows at +20s
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", tAfterSuccess + 20_000L);
        assertEquals(9, bridge.callCount.get());
    }

    @Test
    public void testExceptionPathArmsLadderAndPreservesPresentSnapshot() {
        long t = 2_000_000L;
        FakeGrokBridge bridge = new FakeGrokBridge(makePayload(true));

        // 1. First establish a present snapshot
        JsonObject r1 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t);
        assertTrue(r1.get("present").getAsBoolean());
        assertEquals(1, bridge.callCount.get());

        // 2. At +115s (freshness expired), bridge fails with an exception
        bridge.errorToThrow = new RuntimeException("connection error");
        long tFail1 = t + 115_000L;
        JsonObject r2 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFail1);
        assertStalePercent(r2);
        assertEquals(2, bridge.callCount.get());

        // Exception arms ladder (step 0: 20_000ms). Within +19s, bridge is not called again
        JsonObject r3 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFail1 + 19_000L);
        assertStalePercent(r3);
        assertEquals(2, bridge.callCount.get());

        // At +20s, bridge is called again
        JsonObject r4 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFail1 + 20_000L);
        assertStalePercent(r4);
        assertEquals(3, bridge.callCount.get());

        // Next gap is 60s. Within +59s, bridge is not called again
        JsonObject r5 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFail1 + 20_000L + 59_000L);
        assertStalePercent(r5);
        assertEquals(3, bridge.callCount.get());
    }

    @Test
    public void testSkipPollingPayloadDoesNotCacheOrAdvanceFailureLadder() {
        long t = 3_000_000L;
        FakeGrokBridge bridge = new FakeGrokBridge(GrokSDKBridge.planUsageApiKeySkip());

        JsonObject r1 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t);
        assertFalse(r1.get("present").getAsBoolean());
        assertTrue(r1.get("skipPolling").getAsBoolean());
        assertEquals(1, bridge.callCount.get());

        // Switching auth to OAuth 1s later is not blocked by a cached skipPolling snapshot
        bridge.responseToReturn = makePayload(false);
        JsonObject r2 = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + 1_000L);
        assertFalse(r2.get("present").getAsBoolean());
        assertFalse(r2.has("skipPolling"));
        assertEquals(2, bridge.callCount.get());

        // And the first real failure starts at step 0 (20s), not step 1 (60s)
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + 1_000L + 19_000L);
        assertEquals(2, bridge.callCount.get());
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + 1_000L + 20_000L);
        assertEquals(3, bridge.callCount.get());
    }

    @Test
    public void testEmptyCache20sMiss() {
        long t = 4_000_000L;
        FakeGrokBridge bridge = new FakeGrokBridge(makePayload(false));

        JsonObject first = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t);
        assertHidden(first);
        assertEquals(1, bridge.callCount.get());

        JsonObject within = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + 19_000L);
        assertHidden(within);
        assertEquals(1, bridge.callCount.get());

        JsonObject miss = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + 20_000L);
        assertHidden(miss);
        assertEquals(2, bridge.callCount.get());
    }

    @Test
    public void testStaleMaxBoundary() {
        long t0 = 5_000_000L;
        FakeGrokBridge bridge = new FakeGrokBridge(makePayload(true));
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", t0);

        bridge.responseToReturn = makePayload(false);
        JsonObject stale = GrokPlanUsageService.resolveLocked(
                bridge, "/tmp", t0 + GrokPlanUsageService.STALE_MAX_MS - 1);
        assertStalePercent(stale);
        assertEquals(2, bridge.callCount.get());

        JsonObject hidden = GrokPlanUsageService.resolveLocked(
                bridge, "/tmp", t0 + GrokPlanUsageService.STALE_MAX_MS);
        assertHidden(hidden);
        assertEquals(2, bridge.callCount.get());
    }

    @Test
    public void testClockBackIsNotFreshOrStale() {
        long t = 6_000_000L;
        FakeGrokBridge bridge = new FakeGrokBridge(makePayload(true));
        JsonObject present = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t);
        assertTrue(present.get("present").getAsBoolean());
        assertEquals(50.0, present.get("capacity_pct").getAsDouble(), 0.0);
        assertEquals(1, bridge.callCount.get());

        bridge.responseToReturn = makePayload(false);
        JsonObject missed = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t - 1);
        assertHidden(missed);
        assertEquals(2, bridge.callCount.get());
    }

    @Test
    public void testFreshHitReturnsWhileClassLockIsHeld() throws Exception {
        long t = System.currentTimeMillis() - 1_000L;
        FakeGrokBridge warmer = new FakeGrokBridge(makePayload(true));
        JsonObject warmed = GrokPlanUsageService.resolveLocked(warmer, "/tmp", t);
        assertTrue(warmed.get("present").getAsBoolean());
        assertEquals(50.0, warmed.get("capacity_pct").getAsDouble(), 0.0);

        CountDownLatch holding = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        Thread locker = new Thread(() -> {
            synchronized (GrokPlanUsageService.class) {
                holding.countDown();
                try {
                    release.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }, "grok-plan-usage-lock-holder");
        locker.start();
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            assertTrue(holding.await(5, TimeUnit.SECONDS));
            FakeGrokBridge bridge = new FakeGrokBridge(makePayload(false));
            Future<JsonObject> pending = pool.submit(
                    () -> GrokPlanUsageService.resolvePlanUsagePayload(bridge, "/tmp"));
            JsonObject hit = pending.get(2, TimeUnit.SECONDS);
            assertTrue(hit.get("present").getAsBoolean());
            assertEquals(50.0, hit.get("capacity_pct").getAsDouble(), 0.0);
            assertFalse(hit.has("stale"));
            assertEquals(0, bridge.callCount.get());
        } finally {
            release.countDown();
            locker.join(5_000);
            pool.shutdownNow();
        }
    }

    @Test
    public void testWaiterAfterLockSeesSnapshotStoredDuringTheWait() throws Exception {
        CountDownLatch holding = new CountDownLatch(1);
        CountDownLatch waiterBlocked = new CountDownLatch(1);
        FakeGrokBridge holderBridge = new FakeGrokBridge(makePayload(true));
        Thread holder = new Thread(() -> {
            synchronized (GrokPlanUsageService.class) {
                holding.countDown();
                try {
                    if (!waiterBlocked.await(10, TimeUnit.SECONDS)) {
                        return;
                    }
                    Thread.sleep(50L);
                    GrokPlanUsageService.resolveLocked(
                            holderBridge, "/tmp", System.currentTimeMillis());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }, "grok-plan-usage-lock-holder-store");
        holder.start();
        Thread waiter = null;
        try {
            assertTrue(holding.await(5, TimeUnit.SECONDS));
            FakeGrokBridge waiterBridge = new FakeGrokBridge(makePayload(false));
            AtomicReference<JsonObject> result = new AtomicReference<>();
            waiter = new Thread(
                    () -> result.set(GrokPlanUsageService.resolvePlanUsagePayload(waiterBridge, "/tmp")),
                    "grok-plan-usage-waiter");
            waiter.start();
            long deadline = System.currentTimeMillis() + 5_000L;
            while (waiter.getState() != Thread.State.BLOCKED && System.currentTimeMillis() < deadline) {
                Thread.sleep(1L);
            }
            assertEquals(Thread.State.BLOCKED, waiter.getState());
            waiterBlocked.countDown();
            waiter.join(5_000L);
            assertFalse(waiter.isAlive());
            JsonObject hit = result.get();
            assertNotNull(hit);
            assertTrue(hit.get("present").getAsBoolean());
            assertEquals(50.0, hit.get("capacity_pct").getAsDouble(), 0.0);
            assertFalse(hit.has("stale"));
            assertEquals(0, waiterBridge.callCount.get());
        } finally {
            waiterBlocked.countDown();
            holder.join(5_000L);
            if (waiter != null) {
                waiter.join(5_000L);
            }
        }
    }

    @Test
    public void testSkipPollingAfterPresentClearsThePercent() {
        long t = 7_000_000L;
        FakeGrokBridge bridge = new FakeGrokBridge(makePayload(true));
        JsonObject present = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t);
        assertEquals(50.0, present.get("capacity_pct").getAsDouble(), 0.0);

        bridge.responseToReturn = GrokSDKBridge.planUsageApiKeySkip();
        JsonObject skip = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + GrokPlanUsageService.FRESH_MS);
        assertTrue(skip.get("skipPolling").getAsBoolean());
        assertFalse(skip.has("stale"));
        assertFalse(skip.has("capacity_pct"));
        assertEquals(2, bridge.callCount.get());

        bridge.responseToReturn = makePayload(false);
        JsonObject next = GrokPlanUsageService.resolveLocked(
                bridge, "/tmp", t + GrokPlanUsageService.FRESH_MS + 1_000L);
        assertEquals(3, bridge.callCount.get());
        assertHidden(next);
    }

    @Test
    public void testInterruptRestoresFlagAndKeepsYoungSnapshot() throws Exception {
        long t = 8_000_000L;
        FakeGrokBridge bridge = new FakeGrokBridge(makePayload(true));
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", t);

        bridge.blocked = new CompletableFuture<>();
        long failAt = t + GrokPlanUsageService.FRESH_MS;
        AtomicReference<JsonObject> result = new AtomicReference<>();
        AtomicBoolean interrupted = new AtomicBoolean();
        Thread worker = new Thread(() -> {
            JsonObject payload = GrokPlanUsageService.resolveLocked(bridge, "/tmp", failAt);
            interrupted.set(Thread.currentThread().isInterrupted());
            result.set(payload);
        }, "grok-plan-usage-interrupt");
        worker.start();
        try {
            long deadline = System.currentTimeMillis() + 5_000L;
            while (bridge.callCount.get() < 2 && System.currentTimeMillis() < deadline) {
                Thread.sleep(10L);
            }
            assertEquals(2, bridge.callCount.get());
            worker.interrupt();
            worker.join(5_000L);
        } finally {
            bridge.blocked.complete(makePayload(false));
        }
        assertFalse(worker.isAlive());
        assertTrue(interrupted.get());
        assertStalePercent(result.get());

        bridge.blocked = null;
        JsonObject suppressed = GrokPlanUsageService.resolveLocked(bridge, "/tmp", failAt + 19_000L);
        assertStalePercent(suppressed);
        assertEquals(2, bridge.callCount.get());
    }

    @Test
    public void testDormantKeepsYoungReadingWithoutArmingLadder() {
        long t = 9_000_000L;
        FakeGrokBridge bridge = new FakeGrokBridge(makePayload(true));
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", t);

        // The daemon idle-exited: the reading stays and is marked dormant
        bridge.responseToReturn = GrokSDKBridge.planUsageDormant();
        JsonObject dormant = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + GrokPlanUsageService.FRESH_MS);
        assertStalePercent(dormant);
        assertTrue(dormant.get("dormant").getAsBoolean());
        assertEquals(2, bridge.callCount.get());

        // No backoff: the next tick asks again at once (the daemon is not contacted)
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + GrokPlanUsageService.FRESH_MS + 1_000L);
        assertEquals(3, bridge.callCount.get());

        // Past STALE_MAX_MS the reading ages out like any other
        JsonObject aged = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + GrokPlanUsageService.STALE_MAX_MS);
        assertHidden(aged);
        assertTrue(aged.get("dormant").getAsBoolean());

        // Chat brings the daemon back: the first real failure still starts at the 20s step
        bridge.responseToReturn = makePayload(false);
        long tFail = t + GrokPlanUsageService.STALE_MAX_MS + 1_000L;
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFail);
        int calls = bridge.callCount.get();
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFail + 19_000L);
        assertEquals(calls, bridge.callCount.get());
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", tFail + 20_000L);
        assertEquals(calls + 1, bridge.callCount.get());
    }

    @Test
    public void testSlowFailureBacksOffFromWhenThePollEnded() {
        long t = 10_000_000L;
        AtomicLong clock = new AtomicLong(t);
        FakeGrokBridge bridge = new FakeGrokBridge(makePayload(false));
        // Each RPC runs into the 45s timeout
        bridge.onCall = () -> clock.addAndGet(45_000L);

        JsonObject first = GrokPlanUsageService.resolveLocked(bridge, "/tmp", t, clock::get);
        assertHidden(first);
        assertEquals(1, bridge.callCount.get());

        // A second window that waited on the lock enters right after: the 20s step still holds
        long afterTimeout = t + 45_000L;
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", afterTimeout + 1L, clock::get);
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", afterTimeout + 19_000L, clock::get);
        assertEquals(1, bridge.callCount.get());

        GrokPlanUsageService.resolveLocked(bridge, "/tmp", afterTimeout + 20_000L, clock::get);
        assertEquals(2, bridge.callCount.get());
    }

    @Test
    public void testYoungReadingIsServedWithoutWaitingForAnInFlightPoll() throws Exception {
        // Real clock: old enough to need a refresh, young enough to keep showing
        long storedAt = System.currentTimeMillis() - GrokPlanUsageService.FRESH_MS - 1_000L;
        GrokPlanUsageService.resolveLocked(new FakeGrokBridge(makePayload(true)), "/tmp", storedAt);

        FakeGrokBridge slow = new FakeGrokBridge(makePayload(true));
        slow.blocked = new CompletableFuture<>();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<JsonObject> polling = pool.submit(
                    () -> GrokPlanUsageService.resolvePlanUsagePayload(slow, "/tmp"));
            long deadline = System.currentTimeMillis() + 5_000L;
            while (slow.callCount.get() < 1 && System.currentTimeMillis() < deadline) {
                Thread.sleep(5L);
            }
            assertEquals(1, slow.callCount.get());

            FakeGrokBridge other = new FakeGrokBridge(makePayload(false));
            JsonObject served = pool.submit(
                    () -> GrokPlanUsageService.resolvePlanUsagePayload(other, "/tmp")).get(2, TimeUnit.SECONDS);
            assertStalePercent(served);
            assertTrue(served.get("refreshing").getAsBoolean());
            assertEquals(0, other.callCount.get());

            slow.blocked.complete(makePayload(true));
            JsonObject refreshed = polling.get(5, TimeUnit.SECONDS);
            assertTrue(refreshed.get("present").getAsBoolean());
            assertFalse(refreshed.has("stale"));
        } finally {
            slow.blocked.complete(makePayload(false));
            pool.shutdownNow();
        }
    }

    @Test
    public void testDormantEndsAFailureStreak() {
        long t = 11_000_000L;
        FakeGrokBridge bridge = new FakeGrokBridge(makePayload(false));
        // Climb the ladder to the 5m step: failures at t, t+20s, t+80s
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", t);
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + 20_000L);
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", t + 80_000L);
        assertEquals(3, bridge.callCount.get());

        // The daemon exits after the 5m wait; the poll after it is dormant
        bridge.responseToReturn = GrokSDKBridge.planUsageDormant();
        long tDormant = t + 80_000L + 300_000L;
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", tDormant);
        assertEquals(4, bridge.callCount.get());

        // Chat brings it back and billing fails once: the wait is 20s again, not 30m
        bridge.responseToReturn = makePayload(false);
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", tDormant + 1_000L);
        assertEquals(5, bridge.callCount.get());
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", tDormant + 1_000L + 19_000L);
        assertEquals(5, bridge.callCount.get());
        GrokPlanUsageService.resolveLocked(bridge, "/tmp", tDormant + 1_000L + 20_000L);
        assertEquals(6, bridge.callCount.get());
    }
}

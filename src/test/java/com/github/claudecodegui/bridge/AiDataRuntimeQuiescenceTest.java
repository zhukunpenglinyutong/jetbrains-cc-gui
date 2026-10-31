package com.github.claudecodegui.bridge;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

public class AiDataRuntimeQuiescenceTest {
    @Test
    public void quiescesIdleRuntimesAcrossOwnersBeforeAdmittingMigration() throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();
        IdleRuntime first = new IdleRuntime(gate);
        IdleRuntime second = new IdleRuntime(gate);
        try (AiDataProcessGate.MigrationPermit migration = gate.tryAcquireQuiescentMigrationPermit()) {
            assertNotNull(migration);
            assertEquals(1, first.stops.get());
            assertEquals(1, second.stops.get());
            assertNull(gate.tryAcquireReadPermit());
        }
    }

    @Test
    public void activeRequestRejectsMigrationWithoutStoppingOtherOwners() throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();
        IdleRuntime idle = new IdleRuntime(gate);
        IdleRuntime busy = new IdleRuntime(gate);
        busy.active = true;
        try {
            assertNull(gate.tryAcquireQuiescentMigrationPermit());
            assertEquals(0, idle.stops.get());
            assertEquals(0, busy.stops.get());
            try (AiDataProcessGate.ReadPermit read = gate.tryAcquireReadPermit()) {
                assertNotNull(read);
            }
        } finally {
            idle.permit.close();
            busy.permit.close();
        }
    }

    @Test
    public void newStartDuringQuiescenceCancelsIntentBeforeSpawning() throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();
        CountDownLatch stopping = new CountDownLatch(1);
        CountDownLatch allowStop = new CountDownLatch(1);
        IdleRuntime runtime = new IdleRuntime(gate) {
            @Override
            public boolean stopIfIdle() {
                stopping.countDown();
                try {
                    assertTrue(allowStop.await(5, TimeUnit.SECONDS));
                } catch (InterruptedException error) {
                    throw new AssertionError(error);
                }
                return super.stopIfIdle();
            }
        };
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<AiDataProcessGate.MigrationPermit> migration = executor.submit(gate::tryAcquireQuiescentMigrationPermit);
            assertTrue(stopping.await(5, TimeUnit.SECONDS));
            assertNull(gate.tryAcquireReadPermit());
            assertNull(gate.tryAcquireMigrationPermit());
            CountDownLatch attempting = new CountDownLatch(1);
            Future<AiDataProcessGate.ProcessPermit> start = executor.submit(() -> {
                attempting.countDown();
                return gate.acquireProcessPermit();
            });
            assertTrue(attempting.await(5, TimeUnit.SECONDS));
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (!gate.isCancellationRequested() && System.nanoTime() < deadline) {
                Thread.yield();
            }
            assertTrue(gate.isCancellationRequested());
            assertFalse(start.isDone());
            allowStop.countDown();
            assertNull(migration.get(5, TimeUnit.SECONDS));
            try (AiDataProcessGate.ProcessPermit acquired = start.get(5, TimeUnit.SECONDS)) {
                assertNotNull(acquired);
            }
        } finally {
            allowStop.countDown();
            runtime.permit.close();
            executor.shutdownNow();
        }
    }

    @Test
    public void newStartAfterCommitWaitsWithoutCancelling() throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        AiDataProcessGate.MigrationPermit migration = gate.tryAcquireQuiescentMigrationPermit();
        assertNotNull(migration);
        assertTrue(migration.beginCommit());
        try {
            Future<AiDataProcessGate.ProcessPermit> start = executor.submit(gate::acquireProcessPermit);
            assertFalse(migration.isCancellationRequested());
            assertFalse(start.isDone());
            migration.close();
            try (AiDataProcessGate.ProcessPermit acquired = start.get(5, TimeUnit.SECONDS)) {
                assertNotNull(acquired);
            }
        } finally {
            migration.close();
            executor.shutdownNow();
        }
    }

    private static class IdleRuntime implements AiDataProcessGate.IdleRuntime {
        final AiDataProcessGate.ProcessPermit permit;
        final AiDataProcessGate gate;
        final AtomicInteger stops = new AtomicInteger();
        volatile boolean active;

        IdleRuntime(AiDataProcessGate gate) throws Exception {
            this.gate = gate;
            this.permit = gate.acquireProcessPermit();
            gate.registerRuntime(this);
        }

        @Override
        public boolean hasActiveWork() {
            return active;
        }

        @Override
        public boolean stopIfIdle() {
            assertNull(gate.tryAcquireReadPermit());
            stops.incrementAndGet();
            permit.close();
            return true;
        }
    }
}

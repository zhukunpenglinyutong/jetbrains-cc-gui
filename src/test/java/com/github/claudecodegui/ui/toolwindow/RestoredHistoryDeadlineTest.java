package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/** Exercises the same deadline scheduler used by restored history in the tool window. */
public class RestoredHistoryDeadlineTest {

    @Test
    public void actualFiveSecondDeadlineSettlesTheFutureAndFencesLateCommitAfterRetry() throws Exception {
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try {
            RestoredHistoryLoadRequest expired = new RestoredHistoryLoadRequest(1L, () -> true);
            CompletableFuture<Void> stalledReader = new CompletableFuture<>();
            long started = System.nanoTime();
            expired.bind(stalledReader, scheduler, 5);

            ExecutionException failure = assertThrows(ExecutionException.class,
                    () -> stalledReader.get(15, TimeUnit.SECONDS));

            assertTrue(failure.getCause() instanceof TimeoutException);
            assertTrue("The configured deadline must actually elapse",
                    System.nanoTime() - started >= TimeUnit.SECONDS.toNanos(5));
            assertEquals(RestoredHistoryLoadRequest.TIMEOUT, expired.cancellationCode());
            AtomicInteger committedGeneration = new AtomicInteger();
            RestoredHistoryLoadRequest retry = new RestoredHistoryLoadRequest(2L, () -> true);
            CompletableFuture<Void> freshReader = new CompletableFuture<>();
            retry.bind(freshReader, scheduler, 5);
            assertTrue(retry.commitIfActive(() -> committedGeneration.set(2)));
            freshReader.complete(null);
            freshReader.get(1, TimeUnit.SECONDS);
            assertFalse(expired.commitIfActive(() -> committedGeneration.set(1)));
            assertFalse(stalledReader.complete(null));
            assertEquals(2, committedGeneration.get());
            assertFalse(retry.wasCancelled());
        } finally {
            scheduler.shutdownNow();
            assertTrue(scheduler.awaitTermination(3, TimeUnit.SECONDS));
        }
    }

    @Test
    public void successfulLoadRemovesItsPendingDeadline() throws Exception {
        ScheduledThreadPoolExecutor scheduler = new ScheduledThreadPoolExecutor(1);
        scheduler.setRemoveOnCancelPolicy(true);
        try {
            RestoredHistoryLoadRequest request = new RestoredHistoryLoadRequest(3L, () -> true);
            CompletableFuture<Void> reader = new CompletableFuture<>();
            request.bind(reader, scheduler, 30);
            assertEquals(1, scheduler.getQueue().size());
            reader.complete(null);
            assertTrue(scheduler.getQueue().isEmpty());
            assertFalse(request.wasCancelled());
            assertTrue(request.commitIfActive(() -> { }));
        } finally {
            scheduler.shutdownNow();
            assertTrue(scheduler.awaitTermination(3, TimeUnit.SECONDS));
        }
    }

    @Test
    public void cancellationBeforeBindingSettlesFutureAndRemovesDeadline() throws Exception {
        ScheduledThreadPoolExecutor scheduler = new ScheduledThreadPoolExecutor(1);
        scheduler.setRemoveOnCancelPolicy(true);
        try {
            RestoredHistoryLoadRequest request = new RestoredHistoryLoadRequest(4L, () -> true);
            request.cancel(RestoredHistoryLoadRequest.CANCELLED);
            CompletableFuture<Void> reader = new CompletableFuture<>();
            request.bind(reader, scheduler, 30);
            assertThrows(java.util.concurrent.CancellationException.class, reader::join);
            assertTrue(scheduler.getQueue().isEmpty());
            assertEquals(RestoredHistoryLoadRequest.CANCELLED, request.cancellationCode());
        } finally {
            scheduler.shutdownNow();
            assertTrue(scheduler.awaitTermination(3, TimeUnit.SECONDS));
        }
    }
}

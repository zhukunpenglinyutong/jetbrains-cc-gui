package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertTrue;

public class RestoredHistoryCompletionLockTest {

    @Test
    public void cancellationCallbacksCanInspectTheRequestFromAnotherThread() {
        RestoredHistoryLoadRequest request = new RestoredHistoryLoadRequest(1L, () -> true);
        CompletableFuture<Void> load = new CompletableFuture<>();
        request.bind(load);
        AtomicBoolean inspected = inspectFromCompletion(load, request);

        request.cancel(RestoredHistoryLoadRequest.CANCELLED);
        request.completeExceptionally(new CancellationException("cancelled"));

        assertTrue("Completion must not hold the request lock while acquiring a window lock", inspected.get());
    }

    @Test
    public void bindingAnAlreadyCancelledRequestAlsoCompletesOutsideItsLock() {
        RestoredHistoryLoadRequest request = new RestoredHistoryLoadRequest(2L, () -> true);
        CompletableFuture<Void> load = new CompletableFuture<>();
        AtomicBoolean inspected = inspectFromCompletion(load, request);

        request.cancel(RestoredHistoryLoadRequest.CANCELLED);
        request.bind(load);

        assertTrue("Late binding must permit concurrent request inspection", inspected.get());
    }

    private static AtomicBoolean inspectFromCompletion(CompletableFuture<Void> load, RestoredHistoryLoadRequest request) {
        AtomicBoolean inspected = new AtomicBoolean();
        load.whenComplete((ignored, error) -> {
            try {
                inspected.set(CompletableFuture.supplyAsync(request::wasCancelled).get(2, TimeUnit.SECONDS));
            } catch (Exception blocked) {
                inspected.set(false);
            }
        });
        return inspected;
    }
}

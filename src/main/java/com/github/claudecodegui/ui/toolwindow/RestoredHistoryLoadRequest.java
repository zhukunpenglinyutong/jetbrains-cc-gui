package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.session.SessionMessageOrchestrator;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;

/** Owns cancellation and the final commit gate for one restored-history generation. */
final class RestoredHistoryLoadRequest implements SessionMessageOrchestrator.HistoryLoadCancellation {

    static final String CANCELLED = "HISTORY_LOAD_CANCELLED";
    static final String TIMEOUT = "HISTORY_LOAD_TIMEOUT";

    private final String requestId = UUID.randomUUID().toString();
    private final long generation;
    private final BooleanSupplier currentOwner;
    private boolean cancelled;
    private boolean committed;
    private String cancellationCode;
    private CompletableFuture<Void> future;

    RestoredHistoryLoadRequest(long generation, BooleanSupplier currentOwner) {
        this.generation = generation;
        this.currentOwner = currentOwner;
    }

    String requestId() {
        return requestId;
    }

    long generation() {
        return generation;
    }

    synchronized boolean cancel(String errorCode) {
        if (cancelled) {
            return false;
        }
        cancelled = true;
        cancellationCode = errorCode;
        return true;
    }

    synchronized String cancellationCode() {
        return cancellationCode;
    }

    synchronized boolean wasCancelled() {
        return cancelled;
    }

    synchronized boolean wasCommitted() {
        return committed;
    }

    void bind(CompletableFuture<Void> loadFuture) {
        boolean completeCancelled;
        synchronized (this) {
            future = loadFuture;
            completeCancelled = cancelled;
        }
        if (completeCancelled) {
            loadFuture.completeExceptionally(new java.util.concurrent.CancellationException(
                    "History loading was cancelled"));
        }
    }

    void bind(CompletableFuture<Void> loadFuture, ScheduledExecutorService scheduler, int timeoutSeconds) {
        bind(loadFuture);
        ScheduledFuture<?> deadline = scheduler.schedule(() -> {
            if (!loadFuture.isDone() && cancel(TIMEOUT)) {
                loadFuture.completeExceptionally(new TimeoutException(
                        "History loading timed out after " + timeoutSeconds + " seconds"));
            }
        }, timeoutSeconds, TimeUnit.SECONDS);
        loadFuture.whenComplete((ignored, error) -> deadline.cancel(false));
    }

    void completeExceptionally(Throwable error) {
        CompletableFuture<Void> loadFuture;
        synchronized (this) {
            loadFuture = future;
        }
        // Completion callbacks may acquire the window lock and inspect this request.
        if (loadFuture != null) {
            loadFuture.completeExceptionally(error);
        }
    }

    @Override
    public synchronized boolean isCancelled() {
        return cancelled || !currentOwner.getAsBoolean();
    }

    @Override
    public synchronized boolean commitIfActive(Runnable mutation) {
        if (cancelled || !currentOwner.getAsBoolean()) {
            return false;
        }
        mutation.run();
        committed = true;
        return true;
    }
}

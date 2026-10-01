package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.session.SessionMessageOrchestrator;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;
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

    synchronized void bind(CompletableFuture<Void> loadFuture) {
        future = loadFuture;
        if (cancelled) {
            loadFuture.completeExceptionally(new java.util.concurrent.CancellationException(
                    "History loading was cancelled"));
        }
    }

    synchronized void completeExceptionally(Throwable error) {
        if (future != null) {
            future.completeExceptionally(error);
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

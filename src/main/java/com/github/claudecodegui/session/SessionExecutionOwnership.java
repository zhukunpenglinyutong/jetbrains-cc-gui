package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.SDKResult;

import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

/** Backend authority captured before asynchronous work; never carries a Project, dialog or conversation. */
public record SessionExecutionOwnership(SessionExecutionState state, SessionExecutionState.Turn turn) {
    public void bindInteraction(SessionExecutionState.WaitReason reason, CompletableFuture<?> future) {
        state.bindInteraction(turn, reason, future);
    }

    /** Lifecycle completion is not a successful task result. */
    public void bindLifecycle(CompletableFuture<?> future) {
        state.bindBackendFuture(turn, future);
        future.whenComplete((ignored, error) -> {
            if (error != null) {
                observeFailure(error);
            }
        });
    }

    public void bindResult(CompletableFuture<SDKResult> future) {
        state.bindBackendFuture(turn, future);
        future.whenComplete((result, error) -> {
            if (error != null) {
                observeFailure(error);
            } else if (result == null) {
                state.activity(turn, SessionExecutionState.Phase.UNKNOWN);
            } else {
                state.finish(turn, result.cancelled ? SessionExecutionState.Outcome.CANCELLED
                        : result.success ? SessionExecutionState.Outcome.SUCCEEDED : SessionExecutionState.Outcome.FAILED,
                        result.processExited);
            }
        });
    }

    public void observeFailure(Throwable error) {
        Throwable cause = error instanceof CompletionException && error.getCause() != null ? error.getCause() : error;
        // Cancelling a Java future does not establish that its provider process terminated.
        if (cause instanceof CancellationException) {
            state.activity(turn, SessionExecutionState.Phase.UNKNOWN);
        } else {
            state.finish(turn, SessionExecutionState.Outcome.FAILED);
        }
    }
}

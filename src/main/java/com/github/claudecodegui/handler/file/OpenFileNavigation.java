package com.github.claudecodegui.handler.file;

import com.intellij.openapi.progress.ProcessCanceledException;

import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/** Keeps an unavailable editor from preventing navigation to the same file in the project tree. */
final class OpenFileNavigation {
    private OpenFileNavigation() { }

    static CompletableFuture<Boolean> openOrReveal(BooleanSupplier open, Supplier<CompletableFuture<Boolean>> reveal) {
        try {
            if (open.getAsBoolean()) {
                return CompletableFuture.completedFuture(true);
            }
        } catch (RuntimeException error) {
            letCancellationEscape(error);
            // Binary files and unavailable editor providers still have a useful project-tree target.
        }
        try {
            CompletableFuture<Boolean> selected = reveal.get();
            return selected == null ? CompletableFuture.completedFuture(false)
                    : selected.handle((success, error) -> {
                        letCancellationEscape(error);
                        return error == null && Boolean.TRUE.equals(success);
                    });
        } catch (RuntimeException error) {
            letCancellationEscape(error);
            return CompletableFuture.completedFuture(false);
        }
    }

    static void letCancellationEscape(Throwable error) {
        // Future adapters wrap cancellation; the platform must still receive the original signal.
        Throwable cause = error;
        for (int depth = 0; depth < 32 && (cause instanceof CompletionException || cause instanceof ExecutionException)
                && cause.getCause() != null; depth++) {
            cause = cause.getCause();
        }
        if (cause instanceof ProcessCanceledException cancelled) {
            throw cancelled;
        }
        if (cause instanceof CancellationException cancelled) {
            throw cancelled;
        }
    }
}

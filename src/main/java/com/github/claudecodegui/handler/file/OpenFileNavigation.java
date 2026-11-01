package com.github.claudecodegui.handler.file;

import com.intellij.ide.SelectInContext;
import com.intellij.ide.SelectInTarget;
import com.intellij.openapi.progress.ProcessCanceledException;

import java.util.Collection;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/** Keeps an unavailable editor from preventing navigation to the same file in the project tree. */
final class OpenFileNavigation {
    private OpenFileNavigation() { }

    /** Prefer the current pane when possible without assuming IDEA-specific view IDs. */
    static String findProjectViewId(Collection<SelectInTarget> targets, String currentViewId, SelectInContext context) {
        for (SelectInTarget target : targets) {
            if (currentViewId != null && currentViewId.equals(target.getMinorViewId()) && target.canSelect(context)) {
                return currentViewId;
            }
        }
        for (SelectInTarget target : targets) {
            String viewId = target.getMinorViewId();
            if (viewId != null && !viewId.equals(currentViewId) && target.canSelect(context)) {
                return viewId;
            }
        }
        return null;
    }

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

package com.github.claudecodegui.handler.file;

import com.intellij.openapi.progress.ProcessCanceledException;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletionException;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/** Exercises editor failure, asynchronous project selection and the final navigation outcome. */
public class OpenFileNavigationTest {
    /** Successful text navigation keeps the project tree untouched. */
    @Test
    public void keepsAnOpenedEditorFocused() {
        List<String> actions = new ArrayList<>();
        assertTrue(OpenFileNavigation.openOrReveal(() -> { actions.add("open"); return true; },
                () -> { actions.add("reveal"); return CompletableFuture.completedFuture(true); }).join());
        assertEquals(List.of("open"), actions);
    }

    /** Empty editor results wait for actual project selection rather than reporting an early error. */
    @Test
    public void waitsForProjectSelectionWhenAnArchiveHasNoEditor() {
        CompletableFuture<Boolean> selection = new CompletableFuture<>();
        List<String> actions = new ArrayList<>();
        CompletableFuture<Boolean> navigation = OpenFileNavigation.openOrReveal(() -> { actions.add("open"); return false; },
                () -> { actions.add("reveal"); return selection; });
        assertFalse(navigation.isDone());
        assertEquals(List.of("open", "reveal"), actions);
        selection.complete(true);
        assertTrue(navigation.join());
    }

    /** A provider exception still gives the project tree a chance to reveal the file. */
    @Test
    public void recoversAnEditorExceptionThroughProjectSelection() {
        assertTrue(OpenFileNavigation.openOrReveal(() -> { throw new IllegalStateException("no editor"); },
                () -> CompletableFuture.completedFuture(true)).join());
    }

    /** A rejected or failed project selection is the only unsuccessful navigation result. */
    @Test
    public void reportsFailureAfterProjectSelectionFails() {
        for (CompletableFuture<Boolean> selection : List.of(CompletableFuture.completedFuture(false),
                CompletableFuture.<Boolean>completedFuture(null), CompletableFuture.<Boolean>failedFuture(new IllegalStateException("not found")))) {
            assertFalse(OpenFileNavigation.openOrReveal(() -> false, () -> selection).join());
        }
        assertFalse(OpenFileNavigation.openOrReveal(() -> false, () -> null).join());
        assertFalse(OpenFileNavigation.openOrReveal(() -> false, () -> { throw new IllegalStateException("no project view"); }).join());
    }

    /** Cancellation ends editor navigation without starting project selection. */
    @Test
    public void letsAnEditorCancellationEscape() {
        for (RuntimeException cancellation : List.of(new ProcessCanceledException(), new CancellationException())) {
            List<String> actions = new ArrayList<>();
            RuntimeException thrown = assertThrows(RuntimeException.class,
                    () -> OpenFileNavigation.openOrReveal(() -> { throw cancellation; },
                            () -> { actions.add("reveal"); return CompletableFuture.completedFuture(true); }));
            assertSame(cancellation, thrown);
            assertTrue(actions.isEmpty());
        }
    }

    /** Cancellation of project selection must not become a file-not-found result. */
    @Test
    public void letsProjectSelectionCancellationEscape() {
        for (RuntimeException cancellation : List.of(new ProcessCanceledException(), new CancellationException())) {
            RuntimeException thrown = assertThrows(RuntimeException.class,
                    () -> OpenFileNavigation.openOrReveal(() -> false, () -> { throw cancellation; }));
            assertSame(cancellation, thrown);
            CompletableFuture<Boolean> selection = new CompletableFuture<>();
            CompletableFuture<Boolean> navigation = OpenFileNavigation.openOrReveal(() -> false, () -> selection);
            selection.completeExceptionally(new CompletionException(cancellation));
            assertSame(cancellation, assertThrows(CompletionException.class, navigation::join).getCause());
        }
    }
}

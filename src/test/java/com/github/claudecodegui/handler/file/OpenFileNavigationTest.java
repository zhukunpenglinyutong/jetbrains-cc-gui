package com.github.claudecodegui.handler.file;

import com.intellij.ide.FileEditorProvider;
import com.intellij.ide.SelectInContext;
import com.intellij.ide.SelectInTarget;
import com.intellij.openapi.progress.ProcessCanceledException;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletionException;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/** Exercises editor fallback, project pane choice and asynchronous navigation outcomes. */
public class OpenFileNavigationTest {
    private final List<String> probedViews = new ArrayList<>();

    /** An archive must reach Rider's file-system pane when the solution view cannot reveal it. */
    @Test
    public void findsARiderPaneWithoutAssumingTheIdeaProjectPane() {
        SelectInContext context = this.createSelectionContext();
        List<SelectInTarget> targets = List.of(this.createTarget("SolutionExplorer", false, context),
                this.createTarget("FileSystem", true, context));

        assertEquals("FileSystem", OpenFileNavigation.findProjectViewId(targets, "SolutionExplorer", context));
        assertEquals(List.of("SolutionExplorer", "FileSystem"), this.probedViews);
    }

    /** Keeping a suitable current pane avoids an unnecessary view change and preserves its layout. */
    @Test
    public void keepsTheCurrentPaneWhenItCanRevealTheFile() {
        SelectInContext context = this.createSelectionContext();
        List<SelectInTarget> targets = List.of(this.createTarget("ProjectPane", true, context),
                this.createTarget("FileSystem", true, context));

        assertEquals("FileSystem", OpenFileNavigation.findProjectViewId(targets, "FileSystem", context));
        assertEquals(List.of("FileSystem"), this.probedViews);
    }

    /** Packages cannot reveal every archive, so a selectable registered pane must remain available. */
    @Test
    public void leavesAnUnsuitablePackagesPaneForThePhysicalTree() {
        SelectInContext context = this.createSelectionContext();
        List<SelectInTarget> targets = List.of(this.createTarget("ProjectPane", true, context),
                this.createTarget("PackagesPane", false, context));

        assertEquals("ProjectPane", OpenFileNavigation.findProjectViewId(targets, "PackagesPane", context));
    }

    /** A target without a pane ID cannot be used to switch the project view. */
    @Test
    public void declinesNavigationWhenNoPaneCanRevealTheFile() {
        SelectInContext context = this.createSelectionContext();
        assertNull(OpenFileNavigation.findProjectViewId(List.of(), null, context));
        assertNull(OpenFileNavigation.findProjectViewId(List.of(this.createTarget("PackagesPane", false, context),
                this.createTarget(null, true, context)), "PackagesPane", context));
    }

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

    private SelectInContext createSelectionContext() {
        return new SelectInContext() {
            /** Target-choice tests need only the original context identity. */
            @Override
            public Project getProject() { return null; }

            /** Target-choice tests supply pane capabilities without a live virtual filesystem. */
            @Override
            public VirtualFile getVirtualFile() { return null; }

            /** File navigation selects a whole file rather than a PSI element inside it. */
            @Override
            public Object getSelectorInFile() { return null; }

            /** A project-tree fallback must not reopen the editor that already declined the file. */
            @Override
            public FileEditorProvider getFileEditorProvider() { return null; }
        };
    }

    private SelectInTarget createTarget(String viewId, boolean canSelect, SelectInContext expectedContext) {
        return new SelectInTarget() {
            /** Checking the original context guards against probing a different navigation target. */
            @Override
            public boolean canSelect(SelectInContext context) {
                assertSame(expectedContext, context);
                OpenFileNavigationTest.this.probedViews.add(viewId);
                return canSelect;
            }

            /** Selection must retain the callback path so asynchronous rejection remains observable. */
            @Override
            public void selectIn(SelectInContext context, boolean requestFocus) {
                throw new AssertionError("Use project-view selection callbacks");
            }

            /** IDE-specific pane IDs are deliberately supplied by each fixture. */
            @Override
            public String getMinorViewId() { return viewId; }
        };
    }
}

package com.github.claudecodegui.ui.toolwindow;

import org.cef.browser.CefBrowser;
import org.junit.Test;

import javax.swing.JPanel;
import java.awt.Component;
import java.awt.Rectangle;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for native JCEF repainting, publication-versus-cached-presentation activation
 * decisions, wrapper/native-child eligibility, windowed refresh ownership, and exact OSR
 * timeout ownership across lifecycle changes.
 */
public class WebviewTabActivationTest {

    /** Verifies that a windowed JCEF surface reapplies native bounds without toggling visibility. */
    @Test
    public void reappliesWindowedNativeBoundsForAnEmptyTab() {
        List<String> calls = new ArrayList<>();
        int[][] resized = new int[1][];
        RecordingComponent nativeComponent = new RecordingComponent();
        new JPanel().add(nativeComponent);
        nativeComponent.setBounds(10, 20, 640, 480);
        nativeComponent.startRecording();
        CefBrowser cefBrowser = createCefBrowser(nativeComponent, calls, resized);
        JPanel browserComponent = new JPanel();
        browserComponent.setSize(640, 480);
        AtomicBoolean frontendRepainted = new AtomicBoolean(false);

        assertTrue(ClaudeChatWindow.refreshActivatedWebview(
                new JPanel(), browserComponent, cefBrowser, false,
                () -> frontendRepainted.set(true)));

        assertEquals(Arrays.asList(new Rectangle(10, 20, 640, 480)), nativeComponent.boundsChanges);
        assertTrue(nativeComponent.repainted);
        assertTrue(nativeComponent.visibilityChanges.isEmpty());
        assertFalse(calls.contains("wasResized"));
        assertTrue(calls.contains("notifyScreenInfoChanged"));
        assertTrue(frontendRepainted.get());
    }

    /** Verifies an OSR resize kick explicitly invalidates CEF without hiding its component. */
    @Test
    public void reappliesOsrNativeBoundsWithoutVisibilityRemapping() {
        List<String> calls = new ArrayList<>();
        int[][] resized = new int[1][];
        RecordingComponent nativeComponent = new RecordingComponent();
        new JPanel().add(nativeComponent);
        nativeComponent.setBounds(0, 0, 800, 600);
        nativeComponent.startRecording();
        CefBrowser cefBrowser = createCefBrowser(nativeComponent, calls, resized);
        JPanel browserComponent = new JPanel();
        browserComponent.setSize(800, 600);
        AtomicBoolean frontendRepainted = new AtomicBoolean(false);

        assertTrue(ClaudeChatWindow.refreshActivatedWebview(
                new JPanel(), browserComponent, cefBrowser, true,
                () -> frontendRepainted.set(true)));

        assertEquals(Arrays.asList(new Rectangle(0, 0, 800, 600)), nativeComponent.boundsChanges);
        assertTrue(nativeComponent.repainted);
        assertTrue(nativeComponent.visibilityChanges.isEmpty());
        assertTrue(calls.contains("wasResized"));
        assertTrue(Arrays.equals(new int[]{0, 0}, resized[0]));
        assertTrue(calls.contains("notifyScreenInfoChanged"));
        assertTrue(frontendRepainted.get());
    }

    /** Verifies a delivered OSR full frame is synchronously painted from its backing image. */
    @Test
    public void forcesCompleteOsrPaintBeforeRefreshCompletion() {
        RecordingComponent nativeComponent = new RecordingComponent();
        new JPanel().add(nativeComponent);
        nativeComponent.setBounds(0, 0, 800, 600);
        nativeComponent.startRecording();

        assertTrue(ClaudeChatWindow.forceOsrSurfacePaint(
                new JPanel(), new JPanel(), nativeComponent));

        assertTrue(nativeComponent.repainted);
        assertEquals(1, nativeComponent.immediatePaintCount);
    }

    /** Verifies an unmapped OSR child cannot falsely complete the final paint stage. */
    @Test
    public void rejectsFinalOsrPaintForUnmappedNativeChild() {
        RecordingComponent nativeComponent = new RecordingComponent();
        nativeComponent.surfaceShowing = false;
        nativeComponent.setBounds(0, 0, 800, 600);
        nativeComponent.startRecording();

        assertFalse(ClaudeChatWindow.forceOsrSurfacePaint(
                new JPanel(), new JPanel(), nativeComponent));

        assertEquals(0, nativeComponent.immediatePaintCount);
    }

    /** Verifies active-state selection for managed tabs, pre-binding windows, and detached windows. */
    @Test
    public void resolvesManagedAndDetachedWebviewActivity() {
        assertTrue(ClaudeChatWindow.resolveWebviewActive(true, true, false, false));
        assertFalse(ClaudeChatWindow.resolveWebviewActive(true, false, true, true));
        assertTrue(ClaudeChatWindow.resolveWebviewActive(false, false, false, false));
        assertTrue(ClaudeChatWindow.resolveWebviewActive(false, false, true, true));
        assertFalse(ClaudeChatWindow.resolveWebviewActive(false, false, true, false));
    }

    /** Verifies the first active ready transition requests and publishes before history restoration. */
    @Test
    public void repaintsActiveWebviewOnFirstFrontendReadyTransition() {
        List<String> calls = new ArrayList<>();
        ClaudeChatWindow.FrontendReadyTransitionTracker tracker =
                new ClaudeChatWindow.FrontendReadyTransitionTracker();
        ClaudeChatWindow.FrontendReadyTransition transition = tracker.update(true);

        ClaudeChatWindow.completeFrontendReadyUiUpdate(
                false,
                transition.becameReady(),
                () -> tracker.isCurrentReady(transition.epoch()),
                () -> calls.add("request"),
                () -> true,
                () -> calls.add("publish"),
                () -> calls.add("history")
        );

        assertEquals(Arrays.asList("request", "publish", "history"), calls);
    }

    /** Verifies an older ready task cannot repaint a newer page after a false-to-true cycle. */
    @Test
    public void staleReadyTaskCannotRepaintNewGeneration() {
        AtomicInteger repaintCount = new AtomicInteger();
        AtomicInteger historyCount = new AtomicInteger();
        ClaudeChatWindow.FrontendReadyTransitionTracker tracker =
                new ClaudeChatWindow.FrontendReadyTransitionTracker();

        ClaudeChatWindow.FrontendReadyTransition firstReady = tracker.update(true);
        tracker.update(false);
        ClaudeChatWindow.FrontendReadyTransition secondReady = tracker.update(true);

        ClaudeChatWindow.completeFrontendReadyUiUpdate(
                false,
                firstReady.becameReady(),
                () -> tracker.isCurrentReady(firstReady.epoch()),
                repaintCount::incrementAndGet,
                () -> true,
                repaintCount::incrementAndGet,
                historyCount::incrementAndGet);
        ClaudeChatWindow.completeFrontendReadyUiUpdate(
                false,
                secondReady.becameReady(),
                () -> tracker.isCurrentReady(secondReady.epoch()),
                () -> { },
                () -> true,
                repaintCount::incrementAndGet,
                historyCount::incrementAndGet);

        assertEquals(1, repaintCount.get());
        assertEquals(2, historyCount.get());
    }

    /** Verifies a duplicate ready report neither invalidates nor duplicates the first repaint task. */
    @Test
    public void duplicateReadyKeepsFirstTaskEligibleWithoutSecondRepaint() {
        AtomicInteger repaintCount = new AtomicInteger();
        AtomicInteger historyCount = new AtomicInteger();
        ClaudeChatWindow.FrontendReadyTransitionTracker tracker =
                new ClaudeChatWindow.FrontendReadyTransitionTracker();

        ClaudeChatWindow.FrontendReadyTransition firstReady = tracker.update(true);
        ClaudeChatWindow.FrontendReadyTransition duplicateReady = tracker.update(true);

        ClaudeChatWindow.completeFrontendReadyUiUpdate(
                false,
                firstReady.becameReady(),
                () -> tracker.isCurrentReady(firstReady.epoch()),
                () -> { },
                () -> true,
                repaintCount::incrementAndGet,
                historyCount::incrementAndGet);
        ClaudeChatWindow.completeFrontendReadyUiUpdate(
                false,
                duplicateReady.becameReady(),
                () -> tracker.isCurrentReady(duplicateReady.epoch()),
                () -> { },
                () -> true,
                repaintCount::incrementAndGet,
                historyCount::incrementAndGet);

        assertEquals(1, repaintCount.get());
        assertEquals(2, historyCount.get());
    }

    /** Verifies a hidden ready page creates publication work but defers its execution. */
    @Test
    public void hiddenReadyTransitionRequestsButDoesNotPublish() {
        AtomicInteger requestCount = new AtomicInteger();
        AtomicInteger publishCount = new AtomicInteger();
        AtomicInteger historyCount = new AtomicInteger();
        ClaudeChatWindow.FrontendReadyTransitionTracker tracker =
                new ClaudeChatWindow.FrontendReadyTransitionTracker();
        ClaudeChatWindow.FrontendReadyTransition transition = tracker.update(true);

        ClaudeChatWindow.completeFrontendReadyUiUpdate(
                false,
                transition.becameReady(),
                () -> tracker.isCurrentReady(transition.epoch()),
                requestCount::incrementAndGet,
                () -> false,
                publishCount::incrementAndGet,
                historyCount::incrementAndGet);

        assertEquals(1, requestCount.get());
        assertEquals(0, publishCount.get());
        assertEquals(1, historyCount.get());
    }

    /** Verifies an OSR activation presents cached pixels without creating publication work. */
    @Test
    public void activationConsumesOneCachedSurfacePresentation() {
        ClaudeChatWindow.SurfacePresentationCoordinator coordinator =
                new ClaudeChatWindow.SurfacePresentationCoordinator();
        Object browserIdentity = new Object();
        Object cefBrowserIdentity = new Object();
        AtomicInteger presentationCount = new AtomicInteger();

        assertFalse(coordinator.hasPending());
        coordinator.request(browserIdentity, cefBrowserIdentity, 3, 4L);
        assertTrue(coordinator.hasPending());
        assertTrue(coordinator.tryConsume(
                browserIdentity,
                cefBrowserIdentity,
                3,
                4L,
                () -> true,
                () -> {
                    presentationCount.incrementAndGet();
                    return true;
                }));
        assertFalse(coordinator.hasPending());
        assertEquals(1, presentationCount.get());
    }

    /** Verifies an unmapped cached surface stays pending until a later showing event. */
    @Test
    public void retainsCachedPresentationUntilNativeChildIsShowing() {
        ClaudeChatWindow.SurfacePresentationCoordinator coordinator =
                new ClaudeChatWindow.SurfacePresentationCoordinator();
        Object browserIdentity = new Object();
        Object cefBrowserIdentity = new Object();
        AtomicInteger presentationCount = new AtomicInteger();
        coordinator.request(browserIdentity, cefBrowserIdentity, 3, 4L);

        assertFalse(coordinator.tryConsume(
                browserIdentity, cefBrowserIdentity, 3, 4L,
                () -> false,
                () -> {
                    presentationCount.incrementAndGet();
                    return true;
                }));
        assertTrue(coordinator.hasPending());

        assertTrue(coordinator.tryConsume(
                browserIdentity, cefBrowserIdentity, 3, 4L,
                () -> true,
                () -> {
                    presentationCount.incrementAndGet();
                    return true;
                }));
        assertFalse(coordinator.hasPending());
        assertEquals(1, presentationCount.get());
    }

    /**
     * Verifies OSR activation resumes any outstanding publication, including an active attempt,
     * or presents cached pixels only after publication completes; the generic repaint path
     * remains restricted to windowed JCEF.
     */
    @Test
    public void selectsActivationActionWithoutCreatingOsrPublicationWork() {
        assertEquals(
                ClaudeChatWindow.TabActivationSurfaceAction.PUBLISH_PENDING,
                ClaudeChatWindow.decideTabActivationSurfaceAction(true, true, true));
        assertEquals(
                ClaudeChatWindow.TabActivationSurfaceAction.PRESENT_CACHED,
                ClaudeChatWindow.decideTabActivationSurfaceAction(true, true, false));
        assertEquals(
                ClaudeChatWindow.TabActivationSurfaceAction.WINDOWED_REFRESH,
                ClaudeChatWindow.decideTabActivationSurfaceAction(true, false, false));
        assertEquals(
                ClaudeChatWindow.TabActivationSurfaceAction.NONE,
                ClaudeChatWindow.decideTabActivationSurfaceAction(false, false, false));
    }

    /** Verifies only the current browser and epoch can complete deferred pending work. */
    @Test
    public void completesPendingSurfaceRefreshForCurrentPageOnly() {
        ClaudeChatWindow.SurfaceRefreshCoordinator coordinator =
                new ClaudeChatWindow.SurfaceRefreshCoordinator();
        Object browserIdentity = new Object();
        coordinator.request(browserIdentity, 11L, "history_render_complete");

        assertTrue(coordinator.hasPendingFor(browserIdentity, 11L));
        assertTrue(coordinator.completeCurrent(browserIdentity, 11L));
        assertFalse(coordinator.hasPending());
        assertFalse(coordinator.completeCurrent(browserIdentity, 11L));
    }

    /** Verifies disposal skips active-state lookup, repaint, and restored-history work. */
    @Test
    public void skipsFrontendReadyUiWorkAfterDisposal() {
        AtomicInteger activeCheckCount = new AtomicInteger();
        AtomicInteger repaintCount = new AtomicInteger();
        AtomicInteger historyCount = new AtomicInteger();

        ClaudeChatWindow.completeFrontendReadyUiUpdate(
                true,
                true,
                () -> true,
                repaintCount::incrementAndGet,
                () -> {
                    activeCheckCount.incrementAndGet();
                    return true;
                },
                repaintCount::incrementAndGet,
                historyCount::incrementAndGet);

        assertEquals(0, activeCheckCount.get());
        assertEquals(0, repaintCount.get());
        assertEquals(0, historyCount.get());
    }

    /** Verifies that a current page requests a native refresh after history rendering. */
    @Test
    public void requestsCurrentSurfaceAfterRestoredHistoryRendering() {
        AtomicInteger refreshCount = new AtomicInteger();
        ClaudeChatWindow.FrontendReadyTransitionTracker tracker =
                new ClaudeChatWindow.FrontendReadyTransitionTracker();
        ClaudeChatWindow.FrontendReadyTransition ready = tracker.update(true);

        ClaudeChatWindow.completeHistoryRenderUiUpdate(
                false,
                () -> tracker.isCurrentReady(ready.epoch()),
                refreshCount::incrementAndGet);

        assertEquals(1, refreshCount.get());
    }

    /** Verifies that a history acknowledgment queued by an obsolete page cannot refresh a new page. */
    @Test
    public void staleHistoryRenderTaskCannotRefreshNewGeneration() {
        AtomicInteger refreshCount = new AtomicInteger();
        ClaudeChatWindow.FrontendReadyTransitionTracker tracker =
                new ClaudeChatWindow.FrontendReadyTransitionTracker();
        ClaudeChatWindow.FrontendReadyTransition oldReady = tracker.update(true);
        tracker.update(false);
        tracker.update(true);

        ClaudeChatWindow.completeHistoryRenderUiUpdate(
                false,
                () -> tracker.isCurrentReady(oldReady.epoch()),
                refreshCount::incrementAndGet);

        assertEquals(0, refreshCount.get());
    }

    /** Verifies disposal short-circuits history-render native refresh requests. */
    @Test
    public void skipsHistoryRenderRefreshAfterDisposal() {
        AtomicInteger refreshCount = new AtomicInteger();

        ClaudeChatWindow.completeHistoryRenderUiUpdate(
                true,
                () -> true,
                refreshCount::incrementAndGet);

        assertEquals(0, refreshCount.get());
    }

    /** Verifies a queued history acknowledgment remains owned by the exact browser generation. */
    @Test
    public void historyRenderOwnerRequiresBrowserCefAndGenerationIdentity() {
        Object browser = new Object();
        Object cefBrowser = new Object();

        assertTrue(ClaudeChatWindow.historyRenderOwnerMatches(
                browser, cefBrowser, 4, browser, cefBrowser, 4));
        assertFalse(ClaudeChatWindow.historyRenderOwnerMatches(
                browser, cefBrowser, 4, new Object(), cefBrowser, 4));
        assertFalse(ClaudeChatWindow.historyRenderOwnerMatches(
                browser, cefBrowser, 4, browser, new Object(), 4));
        assertFalse(ClaudeChatWindow.historyRenderOwnerMatches(
                browser, cefBrowser, 4, browser, cefBrowser, 5));
    }

    /** Verifies a hidden surface request remains pending and is consumed exactly once when eligible. */
    @Test
    public void retainsHiddenSurfaceRefreshUntilItCanBeConsumed() {
        ClaudeChatWindow.SurfaceRefreshCoordinator coordinator =
                new ClaudeChatWindow.SurfaceRefreshCoordinator();
        Object browserIdentity = new Object();
        AtomicInteger refreshCount = new AtomicInteger();
        coordinator.request(browserIdentity, 3L, "history_render_complete");

        assertFalse(coordinator.tryConsume(
                browserIdentity, 3L, () -> false,
                () -> {
                    refreshCount.incrementAndGet();
                    return true;
                }));
        assertTrue(coordinator.hasPending());

        assertTrue(coordinator.tryConsume(
                browserIdentity, 3L, () -> true,
                () -> {
                    refreshCount.incrementAndGet();
                    return true;
                }));
        assertFalse(coordinator.hasPending());
        assertFalse(coordinator.tryConsume(browserIdentity, 3L, () -> true, () -> true));
        assertEquals(1, refreshCount.get());
    }

    /** Verifies a failed native resize keeps its request pending for a later lifecycle event. */
    @Test
    public void retainsSurfaceRefreshWhenNativeResizeDoesNotRun() {
        ClaudeChatWindow.SurfaceRefreshCoordinator coordinator =
                new ClaudeChatWindow.SurfaceRefreshCoordinator();
        Object browserIdentity = new Object();
        coordinator.request(browserIdentity, 5L, "history_render_complete");

        assertFalse(coordinator.tryConsume(browserIdentity, 5L, () -> true, () -> false));

        assertTrue(coordinator.hasPending());
    }

    /** Verifies component lifecycle callbacks cannot re-enter an in-progress native refresh. */
    @Test
    public void preventsSurfaceRefreshReentry() {
        ClaudeChatWindow.SurfaceRefreshCoordinator coordinator =
                new ClaudeChatWindow.SurfaceRefreshCoordinator();
        Object browserIdentity = new Object();
        AtomicBoolean nestedConsumed = new AtomicBoolean(true);
        coordinator.request(browserIdentity, 9L, "history_render_complete");

        boolean consumed = coordinator.tryConsume(
                browserIdentity,
                9L,
                () -> true,
                () -> {
                    nestedConsumed.set(coordinator.tryConsume(
                            browserIdentity, 9L, () -> true, () -> true));
                    return true;
                });

        assertTrue(consumed);
        assertFalse(nestedConsumed.get());
        assertFalse(coordinator.hasPending());
    }

    /** Verifies a request owned by an obsolete browser or ready epoch is discarded. */
    @Test
    public void discardsSurfaceRefreshOwnedByObsoletePage() {
        ClaudeChatWindow.SurfaceRefreshCoordinator coordinator =
                new ClaudeChatWindow.SurfaceRefreshCoordinator();
        Object oldBrowser = new Object();
        coordinator.request(oldBrowser, 7L, "history_render_complete");

        assertFalse(coordinator.tryConsume(new Object(), 7L, () -> true, () -> true));
        assertFalse(coordinator.hasPending());

        coordinator.request(oldBrowser, 7L, "history_render_complete");
        assertFalse(coordinator.tryConsume(oldBrowser, 8L, () -> true, () -> true));
        assertFalse(coordinator.hasPending());
    }

    /** Verifies wrapper and real native-child visibility, root state, and geometry gate refresh. */
    @Test
    public void requiresStableVisibleGeometryForSurfaceRefresh() {
        assertTrue(ClaudeChatWindow.isSurfaceRefreshEligible(
                true, true, true, true, true, true, false, 800, 600));
        assertFalse(ClaudeChatWindow.isSurfaceRefreshEligible(
                false, true, true, true, true, true, false, 800, 600));
        assertFalse(ClaudeChatWindow.isSurfaceRefreshEligible(
                true, false, true, true, true, true, false, 800, 600));
        assertFalse(ClaudeChatWindow.isSurfaceRefreshEligible(
                true, true, false, true, true, true, false, 800, 600));
        assertFalse(ClaudeChatWindow.isSurfaceRefreshEligible(
                true, true, true, false, true, true, false, 800, 600));
        assertFalse(ClaudeChatWindow.isSurfaceRefreshEligible(
                true, true, true, true, false, true, false, 800, 600));
        assertFalse(ClaudeChatWindow.isSurfaceRefreshEligible(
                true, true, true, true, true, false, false, 800, 600));
        assertFalse(ClaudeChatWindow.isSurfaceRefreshEligible(
                true, true, true, true, true, true, true, 800, 600));
        assertFalse(ClaudeChatWindow.isSurfaceRefreshEligible(
                true, true, true, true, true, true, false, 0, 600));
    }

    /** Verifies an unmapped native child cannot report success or consume its pending request. */
    @Test
    public void retainsRefreshWhileNativeChildIsNotShowing() {
        List<String> calls = new ArrayList<>();
        int[][] resized = new int[1][];
        RecordingComponent nativeComponent = new RecordingComponent();
        nativeComponent.surfaceShowing = false;
        nativeComponent.setBounds(0, 0, 800, 600);
        nativeComponent.startRecording();
        CefBrowser cefBrowser = createCefBrowser(nativeComponent, calls, resized);
        AtomicBoolean frontendRepainted = new AtomicBoolean(false);

        assertFalse(ClaudeChatWindow.refreshActivatedWebview(
                new JPanel(), new JPanel(), cefBrowser, true,
                () -> frontendRepainted.set(true)));

        assertTrue(nativeComponent.boundsChanges.isEmpty());
        assertFalse(calls.contains("notifyScreenInfoChanged"));
        assertTrue(frontendRepainted.get());
    }

    /** Verifies replacing a phase-A timeout for the same attempt invalidates the older runnable. */
    @Test
    public void replacesTimeoutOnlyForTheSameExactAttempt() {
        ClaudeChatWindow.SurfaceAttemptTimeoutOwner owner =
                new ClaudeChatWindow.SurfaceAttemptTimeoutOwner();
        Object attempt = new Object();
        Runnable phaseATimeout = () -> { };
        Runnable phaseBTimeout = () -> { };

        ClaudeChatWindow.SurfaceAttemptTimeoutOwner.InstallResult first =
                owner.install(attempt, phaseATimeout);
        ClaudeChatWindow.SurfaceAttemptTimeoutOwner.InstallResult second =
                owner.install(attempt, phaseBTimeout);

        assertTrue(first.accepted());
        assertTrue(second.accepted());
        assertTrue(second.previousTask() == phaseATimeout);
        assertFalse(owner.claim(attempt, phaseATimeout));
        assertTrue(owner.claim(attempt, phaseBTimeout));
    }

    /** Verifies a late callback from A cannot cancel B after A timed out and handed off. */
    @Test
    public void lateAttemptCannotRemoveNewerAttemptTimeout() {
        ClaudeChatWindow.SurfaceAttemptTimeoutOwner owner =
                new ClaudeChatWindow.SurfaceAttemptTimeoutOwner();
        Object attemptA = new Object();
        Object attemptB = new Object();
        Runnable timeoutA = () -> { };
        Runnable timeoutB = () -> { };

        assertTrue(owner.install(attemptA, timeoutA).accepted());
        assertTrue(owner.claim(attemptA, timeoutA));
        assertTrue(owner.install(attemptB, timeoutB).accepted());

        assertTrue(owner.remove(attemptA) == null);
        assertTrue(owner.isOwnedBy(attemptB, timeoutB));
        assertTrue(owner.claim(attemptB, timeoutB));
    }

    /** Verifies a different active attempt cannot have its timeout replaced before release. */
    @Test
    public void rejectsTimeoutReplacementOwnedByAnotherAttempt() {
        ClaudeChatWindow.SurfaceAttemptTimeoutOwner owner =
                new ClaudeChatWindow.SurfaceAttemptTimeoutOwner();
        Object attemptA = new Object();
        Object attemptB = new Object();
        Runnable timeoutA = () -> { };
        Runnable timeoutB = () -> { };

        assertTrue(owner.install(attemptA, timeoutA).accepted());
        assertFalse(owner.install(attemptB, timeoutB).accepted());
        assertTrue(owner.isOwnedBy(attemptA, timeoutA));
    }

    private static CefBrowser createCefBrowser(
            Component nativeComponent,
            List<String> calls,
            int[][] resized
    ) {
        return (CefBrowser) Proxy.newProxyInstance(
                CefBrowser.class.getClassLoader(),
                new Class<?>[]{CefBrowser.class},
                (proxy, method, args) -> {
                    calls.add(method.getName());
                    if ("getUIComponent".equals(method.getName())) {
                        return nativeComponent;
                    }
                    if ("wasResized".equals(method.getName())) {
                        resized[0] = new int[]{(int) args[0], (int) args[1]};
                    }
                    return defaultValue(method.getReturnType());
                }
        );
    }

    private static Object defaultValue(Class<?> returnType) {
        if (returnType == boolean.class) {
            return false;
        }
        if (returnType == int.class) {
            return 0;
        }
        if (returnType == double.class) {
            return 0.0d;
        }
        return null;
    }

    private static class RecordingComponent extends JPanel {
        private final List<Boolean> visibilityChanges = new ArrayList<>();
        private final List<Rectangle> boundsChanges = new ArrayList<>();
        private boolean recording;
        private boolean repainted;
        private int immediatePaintCount;
        private boolean surfaceShowing = true;
        private boolean surfaceDisplayable = true;

        private void startRecording() {
            recording = true;
            visibilityChanges.clear();
            boundsChanges.clear();
            repainted = false;
            immediatePaintCount = 0;
        }

        @Override
        public boolean isShowing() {
            return surfaceShowing;
        }

        @Override
        public boolean isDisplayable() {
            return surfaceDisplayable;
        }

        @Override
        public void setVisible(boolean visible) {
            super.setVisible(visible);
            if (recording) {
                visibilityChanges.add(visible);
            }
        }

        @Override
        public void setBounds(int x, int y, int width, int height) {
            super.setBounds(x, y, width, height);
            if (recording) {
                boundsChanges.add(new Rectangle(x, y, width, height));
            }
        }

        @Override
        public void repaint() {
            super.repaint();
            if (recording) {
                repainted = true;
            }
        }

        @Override
        public void paintImmediately(int x, int y, int width, int height) {
            if (recording) {
                immediatePaintCount++;
            }
        }
    }
}

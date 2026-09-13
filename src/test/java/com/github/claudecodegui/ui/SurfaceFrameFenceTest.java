package com.github.claudecodegui.ui;

import org.cef.browser.CefBrowser;
import org.cef.handler.CefRenderHandler;
import org.junit.Test;

import java.awt.Rectangle;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests the real-frame OSR fence, content-revision publication watermark, acknowledged
 * phase-A/phase-B ordering, request/attempt isolation, full-frame forwarding, delegate
 * preservation, and runtimes lacking the remote handler API. Paints arriving before an exact
 * frontend acknowledgment must remain transparent.
 */
public class SurfaceFrameFenceTest {

    /**
     * Verifies a hidden ready page retains unpublished ownership both before and during its
     * visible publication attempt.
     */
    @Test
    public void requestRemainsUnpublishedBeforeAndDuringVisibleAttempt() {
        SurfaceFrameFence fence = new SurfaceFrameFence(new RecordingListener());
        CefBrowser cefBrowser = createCefBrowser();
        Object browserIdentity = new Object();
        SurfaceFrameFence.Request request = fence.requestForTest(
                browserIdentity, cefBrowser, 1, 2L, 0L, "frontend_ready");

        assertTrue(fence.hasPending());
        assertNull(fence.activeAttempt());

        SurfaceFrameFence.Attempt attempt = fence.armForTest(
                browserIdentity, cefBrowser, 1, 2L);
        assertNotNull(attempt);
        assertEquals(request.serial(), attempt.serial());
        assertEquals(1L, attempt.attemptId());
        assertTrue(fence.hasPending());
    }

    /** Verifies the first classic frame drains and only the second frame becomes full-frame. */
    @Test
    public void classicOsrRequiresDrainFrameBeforeFullFinalFrame() {
        RecordingListener listener = new RecordingListener();
        SurfaceFrameFence fence = new SurfaceFrameFence(listener);
        CefBrowser cefBrowser = createCefBrowser();
        List<Rectangle[]> forwardedRects = new ArrayList<>();
        CefRenderHandler delegate = createClassicDelegate(forwardedRects);
        CefRenderHandler wrapped = SurfaceFrameFence.wrapRenderHandler(
                delegate, fence, CefRenderHandler.class.getClassLoader());
        Object browserIdentity = new Object();
        fence.requestForTest(
                browserIdentity, cefBrowser, 3, 7L, "history_dom_committed");

        SurfaceFrameFence.Attempt attempt = fence.armForTest(
                browserIdentity, cefBrowser, 3, 7L);
        assertNotNull(attempt);
        assertEquals(SurfaceFrameFence.Stage.WAITING_PHASE_A_APPLIED, fence.stage());
        assertTrue(fence.acknowledgePhaseApplied(
                attempt, SurfaceFrameFence.DamagePhase.A));
        wrapped.onPaint(cefBrowser, false,
                new Rectangle[]{new Rectangle(2, 3, 10, 20)}, emptyBuffer(), 800, 600);

        assertEquals(1, listener.drained.size());
        assertEquals(0, listener.finalFrames.size());
        assertArrayEquals(
                new Rectangle[]{new Rectangle(2, 3, 10, 20)}, forwardedRects.get(0));
        assertFalse(fence.complete(attempt));
        assertTrue(fence.beginPhaseBApply(attempt));
        assertTrue(fence.acknowledgePhaseApplied(
                attempt, SurfaceFrameFence.DamagePhase.B));

        wrapped.onPaint(cefBrowser, false,
                new Rectangle[]{new Rectangle(4, 5, 30, 40)}, emptyBuffer(), 800, 600);

        assertEquals(1, listener.finalFrames.size());
        assertArrayEquals(
                new Rectangle[]{new Rectangle(0, 0, 800, 600)}, forwardedRects.get(1));
        assertTrue(fence.complete(attempt));
        assertFalse(fence.hasPending());
    }

    /** Verifies popup and non-pending paints pass through without advancing the fence. */
    @Test
    public void popupAndNonPendingFramesAreFullyTransparent() {
        RecordingListener listener = new RecordingListener();
        SurfaceFrameFence fence = new SurfaceFrameFence(listener);
        CefBrowser cefBrowser = createCefBrowser();
        List<Rectangle[]> forwardedRects = new ArrayList<>();
        CefRenderHandler wrapped = SurfaceFrameFence.wrapRenderHandler(
                createClassicDelegate(forwardedRects),
                fence,
                CefRenderHandler.class.getClassLoader());
        Rectangle[] popupRects = {new Rectangle(7, 8, 9, 10)};

        wrapped.onPaint(cefBrowser, false, popupRects, emptyBuffer(), 100, 80);
        Object browserIdentity = new Object();
        fence.requestForTest(browserIdentity, cefBrowser, 1, 2L, "test");
        fence.armForTest(browserIdentity, cefBrowser, 1, 2L);
        wrapped.onPaint(cefBrowser, true, popupRects, emptyBuffer(), 100, 80);

        assertArrayEquals(popupRects, forwardedRects.get(0));
        assertArrayEquals(popupRects, forwardedRects.get(1));
        assertEquals(SurfaceFrameFence.Stage.WAITING_PHASE_A_APPLIED, fence.stage());
        assertTrue(listener.drained.isEmpty());
    }

    /** Verifies incidental paints cannot drain or finalize before their phase ACK is accepted. */
    @Test
    public void framesPassThroughWhileWaitingForFrontendPhaseAcknowledgments() {
        RecordingListener listener = new RecordingListener();
        SurfaceFrameFence fence = new SurfaceFrameFence(listener);
        CefBrowser cefBrowser = createCefBrowser();
        List<Rectangle[]> forwardedRects = new ArrayList<>();
        CefRenderHandler wrapped = SurfaceFrameFence.wrapRenderHandler(
                createClassicDelegate(forwardedRects),
                fence,
                CefRenderHandler.class.getClassLoader());
        Object browserIdentity = new Object();
        fence.requestForTest(browserIdentity, cefBrowser, 3, 4L, "test");
        SurfaceFrameFence.Attempt attempt = fence.armForTest(
                browserIdentity, cefBrowser, 3, 4L);
        Rectangle[] incidentalRects = {new Rectangle(9, 10, 11, 12)};

        wrapped.onPaint(cefBrowser, false, incidentalRects, emptyBuffer(), 300, 200);
        assertEquals(SurfaceFrameFence.Stage.WAITING_PHASE_A_APPLIED, fence.stage());
        assertTrue(listener.drained.isEmpty());

        assertTrue(fence.acknowledgePhaseApplied(
                attempt, SurfaceFrameFence.DamagePhase.A));
        wrapped.onPaint(cefBrowser, false, new Rectangle[0], emptyBuffer(), 300, 200);
        wrapped.onPaint(cefBrowser, false, incidentalRects, emptyBuffer(), 300, 200);

        assertEquals(SurfaceFrameFence.Stage.WAITING_PHASE_B, fence.stage());
        assertArrayEquals(incidentalRects, forwardedRects.get(2));
        assertTrue(listener.finalFrames.isEmpty());
        assertTrue(fence.beginPhaseBApply(attempt));
        wrapped.onPaint(cefBrowser, false, incidentalRects, emptyBuffer(), 300, 200);
        assertTrue(listener.finalFrames.isEmpty());
        assertTrue(fence.acknowledgePhaseApplied(
                attempt, SurfaceFrameFence.DamagePhase.B));
        wrapped.onPaint(cefBrowser, false, incidentalRects, emptyBuffer(), 300, 200);
        assertEquals(1, listener.finalFrames.size());
    }

    /** Verifies duplicate and out-of-order phase acknowledgments cannot skip fence stages. */
    @Test
    public void phaseAcknowledgmentsMustMatchTheExactCurrentStage() {
        SurfaceFrameFence fence = new SurfaceFrameFence(new RecordingListener());
        CefBrowser cefBrowser = createCefBrowser();
        Object browserIdentity = new Object();
        fence.requestForTest(browserIdentity, cefBrowser, 5, 6L, "test");
        SurfaceFrameFence.Attempt attempt = fence.armForTest(
                browserIdentity, cefBrowser, 5, 6L);

        assertFalse(fence.acknowledgePhaseApplied(
                attempt, SurfaceFrameFence.DamagePhase.B));
        assertEquals(SurfaceFrameFence.Stage.WAITING_PHASE_A_APPLIED, fence.stage());
        assertTrue(fence.acknowledgePhaseApplied(
                attempt, SurfaceFrameFence.DamagePhase.A));
        assertFalse(fence.acknowledgePhaseApplied(
                attempt, SurfaceFrameFence.DamagePhase.A));
        assertEquals(SurfaceFrameFence.Stage.DRAINING_FIRST_FRAME, fence.stage());
    }

    /** Verifies a newer pending serial cannot be cleared by the older active attempt. */
    @Test
    public void olderActiveSerialCannotClearNewerPendingRequest() {
        RecordingListener listener = new RecordingListener();
        SurfaceFrameFence fence = new SurfaceFrameFence(listener);
        CefBrowser cefBrowser = createCefBrowser();
        CefRenderHandler wrapped = SurfaceFrameFence.wrapRenderHandler(
                createClassicDelegate(new ArrayList<>()),
                fence,
                CefRenderHandler.class.getClassLoader());
        Object browserIdentity = new Object();
        fence.requestForTest(
                browserIdentity, cefBrowser, 4, 5L, 0L, "frontend_ready");
        SurfaceFrameFence.Attempt firstAttempt = fence.armForTest(
                browserIdentity, cefBrowser, 4, 5L);
        SurfaceFrameFence.Request second = fence.requestForTest(
                browserIdentity, cefBrowser, 4, 5L, 1L, "history_dom_committed");

        assertTrue(fence.acknowledgePhaseApplied(
                firstAttempt, SurfaceFrameFence.DamagePhase.A));
        wrapped.onPaint(cefBrowser, false, new Rectangle[0], emptyBuffer(), 640, 480);
        assertTrue(fence.beginPhaseBApply(firstAttempt));
        assertTrue(fence.acknowledgePhaseApplied(
                firstAttempt, SurfaceFrameFence.DamagePhase.B));
        wrapped.onPaint(cefBrowser, false, new Rectangle[0], emptyBuffer(), 640, 480);

        assertTrue(fence.complete(firstAttempt));
        assertTrue(fence.hasPending());
        assertFalse(fence.complete(firstAttempt));
        SurfaceFrameFence.Attempt secondAttempt = fence.armForTest(
                browserIdentity, cefBrowser, 4, 5L);
        assertNotNull(secondAttempt);
        assertEquals(second.serial(), secondAttempt.serial());
        assertTrue(fence.isActive(secondAttempt));
    }

    /**
     * Verifies a published content revision is not requested again, while a newer history
     * commit creates exactly one additional serial for the same browser page owner.
     */
    @Test
    public void deduplicatesPublishedContentRevisionAndQueuesOnlyNewerContent() {
        RecordingListener listener = new RecordingListener();
        SurfaceFrameFence fence = new SurfaceFrameFence(listener);
        CefBrowser cefBrowser = createCefBrowser();
        CefRenderHandler wrapped = SurfaceFrameFence.wrapRenderHandler(
                createClassicDelegate(new ArrayList<>()),
                fence,
                CefRenderHandler.class.getClassLoader());
        Object browserIdentity = new Object();
        SurfaceFrameFence.Request shell = fence.requestForTest(
                browserIdentity, cefBrowser, 9, 10L, 0L, "frontend_ready");
        SurfaceFrameFence.Attempt attempt = fence.armForTest(
                browserIdentity, cefBrowser, 9, 10L);
        assertNotNull(attempt);
        assertTrue(fence.acknowledgePhaseApplied(
                attempt, SurfaceFrameFence.DamagePhase.A));
        wrapped.onPaint(cefBrowser, false, new Rectangle[0], emptyBuffer(), 640, 480);
        assertTrue(fence.beginPhaseBApply(attempt));
        assertTrue(fence.acknowledgePhaseApplied(
                attempt, SurfaceFrameFence.DamagePhase.B));
        wrapped.onPaint(cefBrowser, false, new Rectangle[0], emptyBuffer(), 640, 480);
        assertTrue(fence.complete(attempt));

        SurfaceFrameFence.Request duplicate = fence.requestForTest(
                browserIdentity, cefBrowser, 9, 10L, 0L, "frontend_ready");
        assertEquals(shell.serial(), duplicate.serial());
        assertEquals(shell.serial(), fence.lastPublishedSerial());
        assertFalse(fence.hasPending());

        SurfaceFrameFence.Request history = fence.requestForTest(
                browserIdentity, cefBrowser, 9, 10L, 1L, "history_dom_committed");
        SurfaceFrameFence.Request duplicateHistory = fence.requestForTest(
                browserIdentity, cefBrowser, 9, 10L, 1L, "history_dom_committed");
        assertTrue(history.serial() > shell.serial());
        assertEquals(history.serial(), duplicateHistory.serial());
        assertEquals(1L, history.contentRevision());
        assertTrue(fence.hasPending());
    }

    /** Verifies lifecycle invalidation clears the published revision watermark. */
    @Test
    public void invalidationAllowsTheSameContentRevisionForANewLifecycle() {
        SurfaceFrameFence fence = new SurfaceFrameFence(new RecordingListener());
        CefBrowser cefBrowser = createCefBrowser();
        Object browserIdentity = new Object();
        SurfaceFrameFence.Request first = fence.requestForTest(
                browserIdentity, cefBrowser, 2, 3L, 0L, "frontend_ready");

        fence.invalidate();
        SurfaceFrameFence.Request afterInvalidation = fence.requestForTest(
                browserIdentity, cefBrowser, 2, 3L, 0L, "frontend_ready");

        assertTrue(afterInvalidation.serial() > first.serial());
        assertEquals(0L, fence.lastPublishedSerial());
        assertTrue(fence.hasPending());
    }

    /** Verifies remote shared-memory final frames force a full raster copy and preserve disposal. */
    @Test
    public void remoteHandlerForcesZeroDirtyCountOnlyForFinalNonPopupFrame() throws Exception {
        ClassLoader loader = CefRenderHandler.class.getClassLoader();
        Class<?> nativeInterface = SurfaceFrameFence.resolveNativeRenderHandlerInterface(loader);
        assertNotNull(nativeInterface);
        List<Integer> forwardedDirtyCounts = new ArrayList<>();
        AtomicInteger disposeCount = new AtomicInteger();
        Object delegate = Proxy.newProxyInstance(
                loader,
                new Class<?>[]{CefRenderHandler.class, nativeInterface},
                (proxy, method, args) -> {
                    if ("onPaintWithSharedMem".equals(method.getName())) {
                        forwardedDirtyCounts.add((Integer) args[2]);
                    } else if ("disposeNativeResources".equals(method.getName())) {
                        disposeCount.incrementAndGet();
                    }
                    return defaultValue(method.getReturnType());
                });
        RecordingListener listener = new RecordingListener();
        SurfaceFrameFence fence = new SurfaceFrameFence(listener);
        CefRenderHandler wrapped = SurfaceFrameFence.wrapRenderHandler(
                (CefRenderHandler) delegate, fence, loader);
        CefBrowser cefBrowser = createCefBrowser();
        Object browserIdentity = new Object();
        fence.requestForTest(browserIdentity, cefBrowser, 8, 9L, "test");
        SurfaceFrameFence.Attempt attempt = fence.armForTest(
                browserIdentity, cefBrowser, 8, 9L);
        assertTrue(fence.acknowledgePhaseApplied(
                attempt, SurfaceFrameFence.DamagePhase.A));
        Method remotePaint = nativeInterface.getMethod(
                "onPaintWithSharedMem", CefBrowser.class, boolean.class, int.class,
                String.class, long.class, int.class, int.class);

        remotePaint.invoke(wrapped, cefBrowser, false, 4, "first", 1L, 1200, 900);
        assertTrue(fence.beginPhaseBApply(listener.drained.get(0)));
        assertTrue(fence.acknowledgePhaseApplied(
                attempt, SurfaceFrameFence.DamagePhase.B));
        remotePaint.invoke(wrapped, cefBrowser, true, 5, "popup", 2L, 1200, 900);
        remotePaint.invoke(wrapped, cefBrowser, false, 6, "final", 3L, 1200, 900);
        nativeInterface.getMethod("disposeNativeResources").invoke(wrapped);

        assertEquals(List.of(4, 5, 0), forwardedDirtyCounts);
        assertEquals(1, listener.drained.size());
        assertEquals(1, listener.finalFrames.size());
        assertEquals(1, disposeCount.get());
    }

    /** Verifies an old runtime without the remote interface resolves to the classic path. */
    @Test
    public void missingRemoteInterfaceDoesNotPreventClassicHandlerLoading() {
        ClassLoader isolatedLoader = new ClassLoader(null) { };

        assertNull(SurfaceFrameFence.resolveNativeRenderHandlerInterface(isolatedLoader));
    }

    /** Verifies old/new platform default-factory shapes resolve without static API linkage. */
    @Test
    public void resolvesBothPlatformDefaultOsrFactoryShapesReflectively() {
        assertEquals(DefaultFieldFactory.DEFAULT,
                SurfaceFrameFence.resolveDefaultFactoryValue(DefaultFieldFactory.class));
        assertEquals(InstanceMethodFactory.INSTANCE,
                SurfaceFrameFence.resolveDefaultFactoryValue(InstanceMethodFactory.class));
    }

    /** Verifies timeout-style release retains pending work and requires a fresh first frame. */
    @Test
    public void releasedAttemptRetainsPendingWithoutCompletingIt() {
        SurfaceFrameFence fence = new SurfaceFrameFence(new RecordingListener());
        CefBrowser cefBrowser = createCefBrowser();
        Object browserIdentity = new Object();
        fence.requestForTest(
                browserIdentity, cefBrowser, 2, 3L, "test");
        SurfaceFrameFence.Attempt attempt = fence.armForTest(
                browserIdentity, cefBrowser, 2, 3L);

        SurfaceFrameFence.ReleaseResult result = fence.releaseAttempt(attempt);
        AtomicInteger handoffCount = new AtomicInteger();

        assertTrue(result.released());
        assertFalse(result.newerPending());
        assertFalse(result.handOffNewer(handoffCount::incrementAndGet));
        assertEquals(0, handoffCount.get());
        assertTrue(fence.hasPending());
        assertFalse(fence.complete(attempt));
        assertNotNull(fence.armForTest(browserIdentity, cefBrowser, 2, 3L));
        assertEquals(SurfaceFrameFence.Stage.WAITING_PHASE_A_APPLIED, fence.stage());
    }

    /** Verifies a timed-out request hands ownership directly to a newer pending serial once. */
    @Test
    public void releasedAttemptReportsNewerPendingForAutomaticHandoff() {
        SurfaceFrameFence fence = new SurfaceFrameFence(new RecordingListener());
        CefBrowser cefBrowser = createCefBrowser();
        Object browserIdentity = new Object();
        fence.requestForTest(
                browserIdentity, cefBrowser, 2, 3L, 0L, "frontend_ready");
        SurfaceFrameFence.Attempt firstAttempt = fence.armForTest(
                browserIdentity, cefBrowser, 2, 3L);
        SurfaceFrameFence.Request latest = fence.requestForTest(
                browserIdentity, cefBrowser, 2, 3L, 1L, "history_dom_committed");
        AtomicInteger handoffCount = new AtomicInteger();

        SurfaceFrameFence.ReleaseResult result = fence.releaseAttempt(firstAttempt);

        assertTrue(result.released());
        assertTrue(result.newerPending());
        assertTrue(result.handOffNewer(handoffCount::incrementAndGet));
        assertFalse(result.handOffNewer(handoffCount::incrementAndGet));
        assertEquals(1, handoffCount.get());
        SurfaceFrameFence.Attempt armed = fence.armForTest(
                browserIdentity, cefBrowser, 2, 3L);
        assertNotNull(armed);
        assertEquals(latest.serial(), armed.serial());
    }

    /** Verifies a late callback from an old arm cannot release or complete a re-armed request. */
    @Test
    public void attemptIdentityProtectsRearmedRequestWithSameSerial() {
        SurfaceFrameFence fence = new SurfaceFrameFence(new RecordingListener());
        CefBrowser cefBrowser = createCefBrowser();
        Object browserIdentity = new Object();
        fence.requestForTest(browserIdentity, cefBrowser, 6, 7L, "history_dom_committed");
        SurfaceFrameFence.Attempt firstAttempt = fence.armForTest(
                browserIdentity, cefBrowser, 6, 7L);

        assertTrue(fence.releaseAttempt(firstAttempt).released());
        SurfaceFrameFence.Attempt secondAttempt = fence.armForTest(
                browserIdentity, cefBrowser, 6, 7L);

        assertNotNull(secondAttempt);
        assertEquals(firstAttempt.serial(), secondAttempt.serial());
        assertFalse(firstAttempt.attemptId() == secondAttempt.attemptId());
        assertFalse(fence.releaseAttempt(firstAttempt).released());
        assertTrue(fence.isActive(secondAttempt));
        assertFalse(fence.complete(firstAttempt));
        assertTrue(fence.isActive(secondAttempt));
    }

    /** Verifies lifecycle invalidation makes queued callbacks unable to force or complete a frame. */
    @Test
    public void lifecycleInvalidationRejectsOldFrameCallbacks() {
        RecordingListener listener = new RecordingListener();
        SurfaceFrameFence fence = new SurfaceFrameFence(listener);
        CefBrowser cefBrowser = createCefBrowser();
        List<Rectangle[]> forwardedRects = new ArrayList<>();
        CefRenderHandler wrapped = SurfaceFrameFence.wrapRenderHandler(
                createClassicDelegate(forwardedRects),
                fence,
                CefRenderHandler.class.getClassLoader());
        Object browserIdentity = new Object();
        fence.requestForTest(
                browserIdentity, cefBrowser, 10, 11L, "test");
        SurfaceFrameFence.Attempt attempt = fence.armForTest(
                browserIdentity, cefBrowser, 10, 11L);

        assertTrue(fence.acknowledgePhaseApplied(
                attempt, SurfaceFrameFence.DamagePhase.A));
        wrapped.onPaint(cefBrowser, false,
                new Rectangle[]{new Rectangle(1, 1, 5, 5)}, emptyBuffer(), 400, 300);
        fence.invalidate();
        wrapped.onPaint(cefBrowser, false,
                new Rectangle[]{new Rectangle(2, 2, 6, 6)}, emptyBuffer(), 400, 300);

        assertArrayEquals(
                new Rectangle[]{new Rectangle(2, 2, 6, 6)}, forwardedRects.get(1));
        assertFalse(fence.complete(attempt));
        assertFalse(fence.hasPending());
        assertEquals(1, listener.drained.size());
        assertTrue(listener.finalFrames.isEmpty());
    }

    private static CefRenderHandler createClassicDelegate(List<Rectangle[]> forwardedRects) {
        return (CefRenderHandler) Proxy.newProxyInstance(
                CefRenderHandler.class.getClassLoader(),
                new Class<?>[]{CefRenderHandler.class},
                (proxy, method, args) -> {
                    if ("onPaint".equals(method.getName())) {
                        forwardedRects.add((Rectangle[]) args[2]);
                    }
                    return defaultValue(method.getReturnType());
                });
    }

    private static CefBrowser createCefBrowser() {
        return (CefBrowser) Proxy.newProxyInstance(
                CefBrowser.class.getClassLoader(),
                new Class<?>[]{CefBrowser.class},
                (proxy, method, args) -> defaultValue(method.getReturnType()));
    }

    private static ByteBuffer emptyBuffer() {
        return ByteBuffer.allocateDirect(1);
    }

    private static Object defaultValue(Class<?> type) {
        if (!type.isPrimitive()) return null;
        if (type == boolean.class) return false;
        if (type == byte.class) return (byte) 0;
        if (type == short.class) return (short) 0;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        if (type == float.class) return 0F;
        if (type == double.class) return 0D;
        if (type == char.class) return (char) 0;
        return null;
    }

    private static final class RecordingListener implements SurfaceFrameFence.Listener {
        private final List<SurfaceFrameFence.Attempt> drained = new ArrayList<>();
        private final List<SurfaceFrameFence.Attempt> finalFrames = new ArrayList<>();

        @Override
        public void onFirstFrameDrained(SurfaceFrameFence.Attempt attempt) {
            drained.add(attempt);
        }

        @Override
        public void onFinalFrameForwarded(SurfaceFrameFence.Attempt attempt) {
            finalFrames.add(attempt);
        }
    }

    /** Mimics IDE versions that expose the default OSR factory as a public field. */
    public static final class DefaultFieldFactory {
        public static final Object DEFAULT = new Object();

        private DefaultFieldFactory() { }
    }

    /** Mimics IDE versions that expose the default OSR factory through getInstance(). */
    public static final class InstanceMethodFactory {
        private static final Object INSTANCE = new Object();

        private InstanceMethodFactory() { }

        /** Returns the singleton value through the newer/alternate API shape. */
        public static Object getInstance() {
            return INSTANCE;
        }
    }
}

package com.github.claudecodegui.ui;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefOSRHandlerFactory;
import com.intellij.util.Function;
import org.cef.browser.CefBrowser;
import org.cef.handler.CefRenderHandler;

import javax.swing.JComponent;
import java.awt.Rectangle;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Turns real OSR paint callbacks into a generation-aware full-frame publication fence.
 *
 * <p>The JetBrains component and its default render handler remain authoritative for input,
 * HiDPI conversion, shared-memory mapping, and backing-image ownership. This class only wraps
 * the handler returned to CEF. Paint gates remain closed until the frontend acknowledges that
 * the matching token's DOM mutation has actually run. The first post-phase-A paint drains any
 * frame already in flight; a post-phase-B paint is forwarded to the default handler as a
 * full-frame update and then reported to the owning chat window for the final EDT paint.</p>
 *
 * <p>The optional remote-render interface is loaded by name. Older supported IDEs that do not
 * provide it therefore create a classic {@link CefRenderHandler} proxy without linking against
 * the missing type.</p>
 */
public final class SurfaceFrameFence {

    private static final Logger LOG = Logger.getInstance(SurfaceFrameFence.class);
    private static final String NATIVE_RENDER_HANDLER_CLASS =
            "org.cef.handler.CefNativeRenderHandler";

    /** State of the currently pending OSR refresh request. */
    public enum Stage {
        PENDING,
        WAITING_PHASE_A_APPLIED,
        DRAINING_FIRST_FRAME,
        WAITING_PHASE_B,
        WAITING_PHASE_B_APPLIED,
        WAITING_FINAL_FRAME,
        PAINT_QUEUED
    }

    /** Frontend viewport-damage phases acknowledged through the generation-gated bridge. */
    public enum DamagePhase {
        A,
        B
    }

    /** Immutable identity of one refresh request. */
    public static final class Request {
        private final Object browserIdentity;
        private final CefBrowser cefBrowser;
        private final int pageGeneration;
        private final long readyEpoch;
        private final long contentRevision;
        private final long serial;
        private final String reason;

        private Request(
                Object browserIdentity,
                CefBrowser cefBrowser,
                int pageGeneration,
                long readyEpoch,
                long contentRevision,
                long serial,
                String reason
        ) {
            this.browserIdentity = browserIdentity;
            this.cefBrowser = cefBrowser;
            this.pageGeneration = pageGeneration;
            this.readyEpoch = readyEpoch;
            this.contentRevision = contentRevision;
            this.serial = serial;
            this.reason = reason;
        }

        public JBCefBrowser browser() {
            return (JBCefBrowser) browserIdentity;
        }

        public CefBrowser cefBrowser() {
            return cefBrowser;
        }

        public int pageGeneration() {
            return pageGeneration;
        }

        public long readyEpoch() {
            return readyEpoch;
        }

        public long contentRevision() {
            return contentRevision;
        }

        public long serial() {
            return serial;
        }

        public String reason() {
            return reason;
        }
    }

    /** Immutable identity of one concrete arm attempt for a logical refresh request. */
    public static final class Attempt {
        private final Request request;
        private final long attemptId;

        private Attempt(Request request, long attemptId) {
            this.request = request;
            this.attemptId = attemptId;
        }

        public JBCefBrowser browser() {
            return request.browser();
        }

        public CefBrowser cefBrowser() {
            return request.cefBrowser();
        }

        public int pageGeneration() {
            return request.pageGeneration();
        }

        public long readyEpoch() {
            return request.readyEpoch();
        }

        public long serial() {
            return request.serial();
        }

        public String reason() {
            return request.reason();
        }

        public long attemptId() {
            return attemptId;
        }
    }

    /** Receives frame milestones after the JetBrains default handler has processed the frame. */
    public interface Listener {
        void onFirstFrameDrained(Attempt attempt);

        void onFinalFrameForwarded(Attempt attempt);
    }

    /** Result of atomically releasing an active frame attempt. */
    public static final class ReleaseResult {
        private static final ReleaseResult NOT_RELEASED = new ReleaseResult(false, false);
        private final boolean released;
        private final boolean newerPending;
        private final AtomicBoolean handoffClaimed = new AtomicBoolean();

        private ReleaseResult(boolean released, boolean newerPending) {
            this.released = released;
            this.newerPending = newerPending;
        }

        public boolean released() {
            return released;
        }

        public boolean newerPending() {
            return newerPending;
        }

        /**
         * Runs a one-shot handoff only when a strictly newer request remained pending.
         * The same timed-out request is deliberately not retried, preventing a timer loop.
         */
        public boolean handOffNewer(Runnable handoff) {
            if (!newerPending || !handoffClaimed.compareAndSet(false, true)) {
                return false;
            }
            handoff.run();
            return true;
        }
    }

    private enum FrameKind {
        PASSTHROUGH,
        DRAIN,
        FINAL
    }

    private static final class FrameDecision {
        private final FrameKind kind;
        private final Attempt attempt;

        private FrameDecision(FrameKind kind, Attempt attempt) {
            this.kind = kind;
            this.attempt = attempt;
        }
    }

    private final Listener listener;
    private long nextSerial;
    private long nextAttemptId;
    private Request pending;
    private Attempt active;
    private Request lastPublished;
    private Stage stage;

    public SurfaceFrameFence(Listener listener) {
        this.listener = listener;
    }

    /**
     * Creates a factory that preserves JetBrains' default component and handler implementation.
     * Only the handler returned to CEF is wrapped with the frame fence.
     */
    public JBCefOSRHandlerFactory createHandlerFactory() {
        JBCefOSRHandlerFactory delegateFactory = resolveDefaultFactory();
        return new JBCefOSRHandlerFactory() {
            @Override
            public JComponent createComponent(boolean isTransparent) {
                JComponent component = delegateFactory.createComponent(isTransparent);
                OsrImeCaretFix.install(component);
                return component;
            }

            @Override
            public CefRenderHandler createCefRenderHandler(JComponent component) {
                CefRenderHandler delegate = delegateFactory.createCefRenderHandler(component);
                return wrapRenderHandler(delegate, SurfaceFrameFence.this,
                        CefRenderHandler.class.getClassLoader());
            }

            @Override
            public Function<? super JComponent, ? extends Rectangle> createScreenBoundsProvider() {
                return delegateFactory.createScreenBoundsProvider();
            }
        };
    }

    /**
     * Requests publication for one content revision. Duplicate or older revisions owned by the
     * same browser page reuse the latest request/published watermark instead of creating a serial.
     */
    public synchronized Request request(
            JBCefBrowser browser,
            CefBrowser cefBrowser,
            int pageGeneration,
            long readyEpoch,
            long contentRevision,
            String reason
    ) {
        return requestInternal(
                browser, cefBrowser, pageGeneration, readyEpoch, contentRevision, reason);
    }

    synchronized Request requestForTest(
            Object browserIdentity,
            CefBrowser cefBrowser,
            int pageGeneration,
            long readyEpoch,
            String reason
    ) {
        return requestInternal(
                browserIdentity, cefBrowser, pageGeneration, readyEpoch, 0L, reason);
    }

    synchronized Request requestForTest(
            Object browserIdentity,
            CefBrowser cefBrowser,
            int pageGeneration,
            long readyEpoch,
            long contentRevision,
            String reason
    ) {
        return requestInternal(
                browserIdentity, cefBrowser, pageGeneration, readyEpoch, contentRevision, reason);
    }

    private Request requestInternal(
            Object browserIdentity,
            CefBrowser cefBrowser,
            int pageGeneration,
            long readyEpoch,
            long contentRevision,
            String reason
    ) {
        if (browserIdentity == null || cefBrowser == null) {
            return null;
        }
        Request latest = latestOwnedRequest(
                browserIdentity, cefBrowser, pageGeneration, readyEpoch);
        if (latest != null && contentRevision <= latest.contentRevision) {
            return latest;
        }
        pending = new Request(
                browserIdentity, cefBrowser, pageGeneration, readyEpoch,
                contentRevision, ++nextSerial, reason);
        if (active == null) {
            stage = Stage.PENDING;
        }
        return pending;
    }

    /** Arms the current request while keeping all paint gates closed until the Phase-A ACK. */
    public synchronized Attempt arm(
            JBCefBrowser browser,
            CefBrowser cefBrowser,
            int pageGeneration,
            long readyEpoch
    ) {
        return armInternal(browser, cefBrowser, pageGeneration, readyEpoch);
    }

    synchronized Attempt armForTest(
            Object browserIdentity,
            CefBrowser cefBrowser,
            int pageGeneration,
            long readyEpoch
    ) {
        return armInternal(browserIdentity, cefBrowser, pageGeneration, readyEpoch);
    }

    private Attempt armInternal(
            Object browserIdentity,
            CefBrowser cefBrowser,
            int pageGeneration,
            long readyEpoch
    ) {
        if (active != null
                || !matches(pending, browserIdentity, cefBrowser, pageGeneration, readyEpoch)
                || stage != Stage.PENDING) {
            return null;
        }
        active = new Attempt(pending, ++nextAttemptId);
        stage = Stage.WAITING_PHASE_A_APPLIED;
        return active;
    }

    /**
     * Releases a stalled or ineligible attempt while retaining the latest request.
     * The result distinguishes a newer pending request from the same timed-out request,
     * allowing the owner to hand off once without creating a timeout retry loop.
     */
    public synchronized ReleaseResult releaseAttempt(Attempt attempt) {
        if (active != attempt || stage == Stage.PENDING) {
            return ReleaseResult.NOT_RELEASED;
        }
        Request released = active.request;
        active = null;
        if (pending == null || pending.serial < released.serial) {
            pending = released;
        }
        stage = Stage.PENDING;
        return new ReleaseResult(
                true, pending != null && pending.serial > released.serial);
    }

    /** Completes the exact final frame and advances this owner's published revision watermark. */
    public synchronized boolean complete(Attempt attempt) {
        if (active != attempt || stage != Stage.PAINT_QUEUED) {
            return false;
        }
        Request completed = active.request;
        active = null;
        lastPublished = completed;
        if (pending == completed) {
            pending = null;
        }
        stage = pending == null ? null : Stage.PENDING;
        return true;
    }

    /** Invalidates pending, in-flight, and published state for a page/browser lifecycle change. */
    public synchronized void invalidate() {
        pending = null;
        active = null;
        lastPublished = null;
        stage = null;
        nextSerial++;
    }

    public synchronized boolean isActive(Attempt attempt) {
        return attempt != null && active == attempt;
    }

    /** Records that Java is about to request Phase B while keeping final paints gated. */
    public synchronized boolean beginPhaseBApply(Attempt attempt) {
        if (active != attempt || stage != Stage.WAITING_PHASE_B) {
            return false;
        }
        stage = Stage.WAITING_PHASE_B_APPLIED;
        return true;
    }

    /**
     * Advances a paint gate only after the frontend confirms the exact token's mutation ran.
     * Duplicate, stale, and out-of-order acknowledgments are rejected without changing state.
     */
    public synchronized boolean acknowledgePhaseApplied(
            Attempt attempt,
            DamagePhase phase
    ) {
        if (active != attempt) {
            return false;
        }
        if (phase == DamagePhase.A && stage == Stage.WAITING_PHASE_A_APPLIED) {
            stage = Stage.DRAINING_FIRST_FRAME;
            return true;
        }
        if (phase == DamagePhase.B && stage == Stage.WAITING_PHASE_B_APPLIED) {
            stage = Stage.WAITING_FINAL_FRAME;
            return true;
        }
        return false;
    }

    /** Returns the exact active attempt so lifecycle invalidation can cancel frontend damage. */
    public synchronized Attempt activeAttempt() {
        return active;
    }

    public synchronized boolean hasPending() {
        return pending != null;
    }

    /**
     * Returns whether unpublished work belongs to the exact current page owner.
     * The pending request remains installed while it is active, so this also covers an
     * in-flight publication attempt and prevents activation from presenting stale pixels.
     */
    public synchronized boolean hasUnpublishedFor(
            JBCefBrowser browser,
            CefBrowser cefBrowser,
            int pageGeneration,
            long readyEpoch
    ) {
        return matches(pending, browser, cefBrowser, pageGeneration, readyEpoch);
    }

    synchronized long lastPublishedSerial() {
        return lastPublished == null ? 0L : lastPublished.serial;
    }

    public synchronized String pendingReason() {
        return pending == null ? null : pending.reason;
    }

    synchronized Stage stage() {
        return stage;
    }

    private synchronized FrameDecision beginFrame(CefBrowser browser, boolean popup) {
        if (popup || active == null || active.cefBrowser() != browser) {
            return new FrameDecision(FrameKind.PASSTHROUGH, null);
        }
        if (stage == Stage.DRAINING_FIRST_FRAME) {
            return new FrameDecision(FrameKind.DRAIN, active);
        }
        if (stage == Stage.WAITING_FINAL_FRAME || stage == Stage.PAINT_QUEUED) {
            return new FrameDecision(FrameKind.FINAL, active);
        }
        return new FrameDecision(FrameKind.PASSTHROUGH, null);
    }

    private void finishFrame(FrameDecision decision) {
        Attempt callbackAttempt = null;
        boolean firstFrame = false;
        synchronized (this) {
            if (active != decision.attempt) {
                return;
            }
            if (decision.kind == FrameKind.DRAIN && stage == Stage.DRAINING_FIRST_FRAME) {
                stage = Stage.WAITING_PHASE_B;
                callbackAttempt = active;
                firstFrame = true;
            } else if (decision.kind == FrameKind.FINAL && stage == Stage.WAITING_FINAL_FRAME) {
                stage = Stage.PAINT_QUEUED;
                callbackAttempt = active;
            }
        }
        if (callbackAttempt == null) {
            return;
        }
        try {
            if (firstFrame) {
                listener.onFirstFrameDrained(callbackAttempt);
            } else {
                listener.onFinalFrameForwarded(callbackAttempt);
            }
        } catch (RuntimeException | LinkageError e) {
            // The default handler has already accepted the frame. A plugin-side scheduling
            // failure must never escape back into CEF. Keep the attempt active so its owned
            // timeout performs the normal host-side cleanup and removes the frontend sentinel.
            LOG.warn("Failed to schedule OSR frame-fence milestone", e);
        }
    }

    private static boolean matches(
            Request request,
            Object browserIdentity,
            CefBrowser cefBrowser,
            int pageGeneration,
            long readyEpoch
    ) {
        return request != null
                && request.browserIdentity == browserIdentity
                && request.cefBrowser == cefBrowser
                && request.pageGeneration == pageGeneration
                && request.readyEpoch == readyEpoch;
    }

    private Request latestOwnedRequest(
            Object browserIdentity,
            CefBrowser cefBrowser,
            int pageGeneration,
            long readyEpoch
    ) {
        Request latest = null;
        if (matches(lastPublished, browserIdentity, cefBrowser, pageGeneration, readyEpoch)) {
            latest = lastPublished;
        }
        if (active != null
                && matches(active.request, browserIdentity, cefBrowser, pageGeneration, readyEpoch)
                && (latest == null || active.request.serial > latest.serial)) {
            latest = active.request;
        }
        if (matches(pending, browserIdentity, cefBrowser, pageGeneration, readyEpoch)
                && (latest == null || pending.serial > latest.serial)) {
            latest = pending;
        }
        return latest;
    }

    static CefRenderHandler wrapRenderHandler(
            CefRenderHandler delegate,
            SurfaceFrameFence fence,
            ClassLoader loader
    ) {
        List<Class<?>> interfaces = new ArrayList<>();
        interfaces.add(CefRenderHandler.class);
        Class<?> nativeInterface = resolveNativeRenderHandlerInterface(loader);
        if (nativeInterface != null && nativeInterface.isInstance(delegate)) {
            interfaces.add(nativeInterface);
        }
        InvocationHandler invocationHandler =
                (proxy, method, args) -> invokeHandler(delegate, fence, method, args);
        return (CefRenderHandler) Proxy.newProxyInstance(
                loader, interfaces.toArray(new Class<?>[0]), invocationHandler);
    }

    static Class<?> resolveNativeRenderHandlerInterface(ClassLoader loader) {
        try {
            return Class.forName(NATIVE_RENDER_HANDLER_CLASS, false, loader);
        } catch (ClassNotFoundException | LinkageError e) {
            return null;
        }
    }

    static JBCefOSRHandlerFactory resolveDefaultFactory() {
        return (JBCefOSRHandlerFactory) resolveDefaultFactoryValue(
                JBCefOSRHandlerFactory.class);
    }

    static Object resolveDefaultFactoryValue(Class<?> factoryClass) {
        try {
            // IDEA 2024.1 and 2025.2 expose DEFAULT, while the project's 2024.3
            // compile baseline exposes getInstance(). Avoid static linkage to either shape.
            return factoryClass
                    .getField("DEFAULT")
                    .get(null);
        } catch (NoSuchFieldException e) {
            try {
                return factoryClass
                        .getMethod("getInstance")
                        .invoke(null);
            } catch (ReflectiveOperationException | LinkageError fallbackFailure) {
                throw new IllegalStateException(
                        "No compatible JBCefOSRHandlerFactory default is available",
                        fallbackFailure);
            }
        } catch (ReflectiveOperationException | LinkageError e) {
            throw new IllegalStateException(
                    "Failed to resolve the default JBCefOSRHandlerFactory", e);
        }
    }

    private static Object invokeHandler(
            CefRenderHandler delegate,
            SurfaceFrameFence fence,
            Method method,
            Object[] originalArgs
    ) throws Throwable {
        Object[] args = originalArgs == null ? new Object[0] : originalArgs.clone();
        FrameDecision decision = null;
        String methodName = method.getName();
        if ("onPaintWithSharedMem".equals(methodName) && args.length == 7) {
            decision = fence.beginFrame((CefBrowser) args[0], (Boolean) args[1]);
            if (decision.kind == FrameKind.FINAL) {
                args[2] = 0;
            }
        } else if ("onPaint".equals(methodName) && args.length == 6) {
            decision = fence.beginFrame((CefBrowser) args[0], (Boolean) args[1]);
            if (decision.kind == FrameKind.FINAL) {
                int width = (Integer) args[4];
                int height = (Integer) args[5];
                args[2] = new Rectangle[]{new Rectangle(0, 0, width, height)};
            }
        }

        boolean delegated = false;
        try {
            Object result = method.invoke(delegate, args);
            delegated = true;
            return result;
        } catch (InvocationTargetException e) {
            throw e.getCause();
        } finally {
            if (decision != null) {
                if (delegated) {
                    fence.finishFrame(decision);
                }
            }
        }
    }
}

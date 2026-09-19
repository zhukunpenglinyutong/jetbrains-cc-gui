package com.github.claudecodegui.ui.toolwindow;

import com.intellij.openapi.diagnostic.Logger;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.IntSupplier;
import java.util.function.Supplier;

/**
 * Serializes Java-to-webview calls and keeps the pending work bounded.
 */
final class WebviewEventQueue<T> {

    private static final Logger LOG = Logger.getInstance(WebviewEventQueue.class);
    private static final int MAX_PENDING_EVENTS = 256;
    /**
     * Hard ceiling for the recovery-event overflow below. Snapshot and boundary
     * calls are the only state from which the frontend can rebuild a transcript, so
     * they are allowed past {@link #MAX_PENDING_EVENTS} rather than dropped. That
     * exemption rests on every exempt type being low-frequency (latest-only or a
     * one-shot edge), which is true of the current callers but is not enforced by
     * the queue. This bound keeps a future caller that violates that assumption
     * from growing the queue without limit; past it the event is dropped exactly as
     * a non-recovery one would be.
     */
    private static final int MAX_RECOVERY_OVERFLOW_EVENTS = MAX_PENDING_EVENTS * 2;
    /**
     * How many times one batch may be requeued after a failed execution before it
     * is dropped. The failure is retried as soon as the scheduler runs again, so
     * without a bound a persistently failing browser would keep the queue draining
     * in a tight loop on the UI thread.
     */
    private static final int MAX_EXECUTION_RETRIES = 3;
    private static final int MAX_BATCH_ARGUMENT_CHARS = 256_000;
    private static final long UNAVAILABLE_WARN_INTERVAL_NANOS = TimeUnit.SECONDS.toNanos(10);

    @FunctionalInterface
    interface ScriptExecutor<T> {
        boolean accept(T browser, int pageGeneration, String script);
    }

    private final Supplier<T> browserSupplier;
    private final BooleanSupplier disposedSupplier;
    private final IntSupplier pageGenerationSupplier;
    private final Consumer<Runnable> scheduler;
    private final ScriptExecutor<T> scriptExecutor;
    private final BooleanSupplier readySupplier;
    private final Object lock = new Object();
    private final Deque<JsCall<T>> pending = new ArrayDeque<>();
    private T queuedBrowser;
    private int queuedPageGeneration;
    private volatile long lastUnavailableWarnNanos;
    private boolean drainScheduled;
    private boolean draining;
    private boolean disposed;

    WebviewEventQueue(
            Supplier<T> browserSupplier,
            BooleanSupplier disposedSupplier,
            IntSupplier pageGenerationSupplier,
            Consumer<Runnable> scheduler,
            ScriptExecutor<T> scriptExecutor,
            BooleanSupplier readySupplier
    ) {
        this.browserSupplier = browserSupplier;
        this.disposedSupplier = disposedSupplier;
        this.pageGenerationSupplier = pageGenerationSupplier;
        this.scheduler = scheduler;
        this.scriptExecutor = scriptExecutor;
        this.readySupplier = readySupplier;
        this.queuedBrowser = browserSupplier.get();
        this.queuedPageGeneration = pageGenerationSupplier.getAsInt();
    }

    boolean enqueue(String functionName, String... args) {
        T browser = currentBrowser();
        if (browser == null) {
            warnBrowserUnavailable(functionName);
            return false;
        }
        return enqueue(new JsCall<T>(browser, pageGeneration(), functionName, copyArgs(args), null));
    }

    boolean enqueueRaw(String script) {
        if (script == null || script.isEmpty()) {
            return false;
        }
        T browser = currentBrowser();
        if (browser == null) {
            warnBrowserUnavailable("raw");
            return false;
        }
        return enqueue(new JsCall<T>(browser, pageGeneration(), null, new String[0], script));
    }

    void browserChanged() {
        resetQueueTracking("browser was replaced");
    }

    void pageChanged() {
        resetQueueTracking("page generation changed");
    }

    void readyChanged() {
        boolean scheduleDrain = false;
        synchronized (lock) {
            if (!disposed && !pending.isEmpty() && !drainScheduled && !draining) {
                drainScheduled = true;
                scheduleDrain = true;
            }
        }
        if (scheduleDrain) {
            scheduleDrain();
        }
    }

    private void resetQueueTracking(String reason) {
        synchronized (lock) {
            logAndClearPending(reason);
            queuedBrowser = browserSupplier.get();
            queuedPageGeneration = pageGeneration();
        }
    }

    void dispose() {
        synchronized (lock) {
            disposed = true;
            pending.clear();
            queuedBrowser = null;
        }
    }

    static String buildBatchScript(List<? extends JsCall<?>> calls) {
        StringBuilder script = new StringBuilder("(function() {\n");
        for (JsCall<?> call : calls) {
            if (call.rawScript != null) {
                script.append("try { (function() {\n")
                        .append(call.rawScript)
                        .append("\n})(); } catch (e) { console.error('[Backend->Frontend] Raw JS failed:', e); }\n");
                continue;
            }

            String callee = call.functionName.contains(".")
                    ? call.functionName : "window." + call.functionName;
            script.append("try { if (typeof ")
                    .append(callee)
                    .append(" === 'function') { ")
                    .append(callee)
                    .append('(');
            for (int i = 0; i < call.args.length; i++) {
                if (i > 0) {
                    script.append(", ");
                }
                script.append('\'')
                        .append(call.args[i] == null ? "" : call.args[i])
                        .append('\'');
            }
            script.append("); } } catch (e) { console.error('[Backend->Frontend] Failed to call " )
                    .append(call.functionName)
                    .append("', e); }\n");
        }
        return script.append("})();").toString();
    }

    private T currentBrowser() {
        if (disposed || disposedSupplier.getAsBoolean()) {
            return null;
        }
        return browserSupplier.get();
    }

    /**
     * Throttled warning for events dropped because no webview is available. The
     * enqueue path can be hit at streaming frequency while the tool window has no
     * browser yet, so the warning is rate-limited instead of silent. Teardown is
     * excluded: dropping there is expected, not diagnostic.
     */
    private void warnBrowserUnavailable(String eventKind) {
        if (disposed || disposedSupplier.getAsBoolean()) {
            return;
        }
        long now = System.nanoTime();
        if (now - lastUnavailableWarnNanos < UNAVAILABLE_WARN_INTERVAL_NANOS) {
            return;
        }
        lastUnavailableWarnNanos = now;
        LOG.warn("Dropping webview event (" + eventKind + ") because no browser is available yet");
    }

    private boolean enqueue(JsCall<T> call) {
        boolean scheduleDrain = false;
        synchronized (lock) {
            if (disposed || disposedSupplier.getAsBoolean()) {
                return false;
            }
            // A sender delayed after capturing its page must not clear events already queued for the new page.
            if (call.browser != browserSupplier.get() || call.pageGeneration != pageGeneration()) {
                return false;
            }
            if (queuedBrowser != call.browser || queuedPageGeneration != call.pageGeneration) {
                logAndClearPending("browser or page generation changed");
                queuedBrowser = call.browser;
                queuedPageGeneration = call.pageGeneration;
            }

            // Supersede snapshots only within the current lifecycle segment,
            // retaining the baselines needed by later tails.
            if (isMessageSnapshot(call)) {
                removeSupersededMessageSnapshots(call);
            }
            if (isDelta(call) && mergeWithTailDelta(call)) {
                return true;
            }
            if (isLatestOnly(call) && mergeWithTailLatest(call)) {
                return true;
            }
            if (pending.size() >= MAX_PENDING_EVENTS
                    && !dropOneDisposableEvent()
                    && !dropOneDelta()
                    && !(isLifecycle(call) && dropOneNonLifecycle())) {
                if (!isCriticalLifecycle(call) && !isMessageSnapshot(call)) {
                    LOG.warn("Dropping webview event because the bounded queue is full: "
                            + (call.functionName != null ? call.functionName : "raw"));
                    return false;
                }
                // Snapshot and boundary calls are the recovery points for the whole
                // transcript. Let one such call exceed the soft bound rather than
                // losing the only state from which the frontend can rebuild. These
                // types are all low-frequency and every one of them is latest-only or
                // a one-shot edge, so the overflow this admits is bounded in practice.
                if (pending.size() >= MAX_RECOVERY_OVERFLOW_EVENTS) {
                    LOG.warn("Dropping recovery event past the overflow ceiling: "
                            + (call.functionName != null ? call.functionName : "raw"));
                    return false;
                }
                LOG.warn("Temporarily exceeding the bounded webview queue for recovery event: "
                        + (call.functionName != null ? call.functionName : "raw"));
            }
            pending.addLast(call);
            if (!drainScheduled && !draining) {
                drainScheduled = true;
                scheduleDrain = true;
            }
        }
        if (scheduleDrain) {
            scheduleDrain();
        }
        return true;
    }

    private void scheduleDrain() {
        try {
            scheduler.accept(this::drain);
        } catch (RuntimeException e) {
            synchronized (lock) {
                drainScheduled = false;
            }
            LOG.warn("Failed to schedule webview event drain: " + e.getMessage(), e);
        }
    }

    private int pageGeneration() {
        return pageGenerationSupplier.getAsInt();
    }

    private void logAndClearPending(String reason) {
        if (!pending.isEmpty()) {
            LOG.warn("Clearing " + pending.size()
                    + " queued webview event(s) because " + reason);
        }
        pending.clear();
    }

    private void drain() {
        List<JsCall<T>> batch;
        T targetBrowser;
        int targetPageGeneration;
        synchronized (lock) {
            drainScheduled = false;
            if (disposed || pending.isEmpty()) {
                return;
            }
            targetBrowser = browserSupplier.get();
            targetPageGeneration = pageGeneration();
            if (targetBrowser == null || disposedSupplier.getAsBoolean()) {
                // Keep the calls and the original queuedBrowser marker: if the same
                // browser instance comes back, the retained calls still match and
                // drain normally. A genuine page rebuild clears them: every reload
                // path (initial load, watchdog reload, recreate) bumps the page
                // generation through beginPageLoad/invalidateCurrentPage before
                // activating it, and activatePageGeneration then reports the change
                // here as pageChanged(). That is also why retaining across a null
                // browser cannot leak into the next page.
                // A later page-ready replay or enqueue will schedule the drain again.
                return;
            }
            if (targetBrowser != queuedBrowser || targetPageGeneration != queuedPageGeneration) {
                logAndClearPending("browser or page generation changed at drain time");
                queuedBrowser = targetBrowser;
                queuedPageGeneration = targetPageGeneration;
                return;
            }
            if (!readySupplier.getAsBoolean()) {
                // Keep calls until runtimeBootstrap and React callback registration
                // have completed; a missing function would otherwise fail silently.
                return;
            }
            draining = true;
            batch = takeBatch();
        }

        boolean executed = false;
        try {
            executed = scriptExecutor.accept(targetBrowser, targetPageGeneration, buildBatchScript(batch));
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to execute queued webview events: " + e.getMessage(), e);
        } finally {
            boolean scheduleDrain = false;
            synchronized (lock) {
                draining = false;
                if (!executed && canRequeue(targetBrowser, targetPageGeneration)) {
                    requeueAtFront(batch);
                }
                if (!disposed && !pending.isEmpty() && !drainScheduled) {
                    drainScheduled = true;
                    scheduleDrain = true;
                }
            }
            if (scheduleDrain) {
                scheduleDrain();
            }
        }
    }

    private boolean canRequeue(T targetBrowser, int targetPageGeneration) {
        return !disposed
                && !disposedSupplier.getAsBoolean()
                && targetBrowser == browserSupplier.get()
                && targetPageGeneration == pageGeneration()
                && targetBrowser == queuedBrowser
                && targetPageGeneration == queuedPageGeneration;
    }

    private void requeueAtFront(List<JsCall<T>> batch) {
        int dropped = 0;
        for (int i = batch.size() - 1; i >= 0; i--) {
            JsCall<T> call = batch.get(i);
            if (call.executionAttempts >= MAX_EXECUTION_RETRIES) {
                dropped++;
                continue;
            }
            call.executionAttempts++;
            pending.addFirst(call);
        }
        if (dropped > 0) {
            LOG.warn("Dropping " + dropped + " webview event(s) after "
                    + MAX_EXECUTION_RETRIES + " failed execution attempts");
        }
    }

    /**
     * Takes the next batch from {@code pending}. Callers must hold the lock and
     * have verified that the live browser/page generation still matches the
     * queued ones — every pending entry carries exactly those values, so no
     * per-entry staleness check is needed here.
     */
    private List<JsCall<T>> takeBatch() {
        List<JsCall<T>> batch = new ArrayList<>();
        int estimatedChars = 0;
        Iterator<JsCall<T>> iterator = pending.iterator();
        while (iterator.hasNext()) {
            JsCall<T> call = iterator.next();
            int callChars = call.estimatedChars();
            if (!batch.isEmpty()
                    && containsMessageSnapshot(batch)
                    && isSnapshotResetBoundary(call)) {
                break;
            }
            if (!batch.isEmpty() && estimatedChars + callChars > MAX_BATCH_ARGUMENT_CHARS) {
                break;
            }
            iterator.remove();
            batch.add(call);
            estimatedChars += callChars;
        }
        return batch;
    }

    private static boolean containsMessageSnapshot(List<? extends JsCall<?>> calls) {
        return calls.stream().anyMatch(WebviewEventQueue::isMessageSnapshot);
    }

    /**
     * Everything the eviction and merging rules ask about a queued call.
     *
     * <p>Which classes a webview function belongs to is declared once, in
     * {@link #EVENT_CLASSES}, rather than as scattered {@code functionName}
     * comparisons: a function that is silently missing from some of the rules
     * changes how it is dropped or merged, and nothing reports that. Adding a
     * function now forces the single decision that matters — its classes.</p>
     */
    enum EventClass {
        /** Adjacent calls concatenate their arguments into one. */
        DELTA,
        /** Adjacent calls collapse to the newest. */
        LATEST_ONLY,
        /** First to go when the bounded queue needs room. */
        DISPOSABLE,
        /** A whole-transcript snapshot, full or tail. */
        SNAPSHOT,
        /** A tail snapshot: meaningless without the full baseline it extends. */
        SNAPSHOT_TAIL,
        /** Splits a batch so the snapshot queued before it is delivered first. */
        RESET_BOUNDARY,
        /** A recovery point: the only events allowed past the soft queue bound. */
        CRITICAL,
        /** Never dropped to make room for a non-lifecycle event. */
        LIFECYCLE,
    }

    /** Package-private so the classification is pinned by a test, like a schema. */
    static final Map<String, Set<EventClass>> EVENT_CLASSES = buildEventClasses();

    private static Map<String, Set<EventClass>> buildEventClasses() {
        Map<String, Set<EventClass>> classes = new HashMap<>();
        classes.put("onContentDelta", EnumSet.of(EventClass.DELTA));
        classes.put("onThinkingDelta", EnumSet.of(EventClass.DELTA));
        classes.put("updateStatus", EnumSet.of(EventClass.LATEST_ONLY, EventClass.DISPOSABLE));
        classes.put("showLoading", EnumSet.of(EventClass.LATEST_ONLY));
        classes.put("showThinkingStatus", EnumSet.of(EventClass.LATEST_ONLY));
        classes.put("setSessionId", EnumSet.of(EventClass.LATEST_ONLY));
        classes.put("onUsageUpdate", EnumSet.of(EventClass.LATEST_ONLY, EventClass.DISPOSABLE));
        classes.put("onStreamingHeartbeat", EnumSet.of(EventClass.LATEST_ONLY, EventClass.DISPOSABLE));
        classes.put("updateMessages", EnumSet.of(EventClass.SNAPSHOT, EventClass.LIFECYCLE));
        classes.put("updateMessageTail", EnumSet.of(
                EventClass.SNAPSHOT, EventClass.SNAPSHOT_TAIL, EventClass.LIFECYCLE));
        classes.put("onStreamStart", EnumSet.of(
                EventClass.RESET_BOUNDARY, EventClass.CRITICAL, EventClass.LIFECYCLE));
        classes.put("clearMessages", EnumSet.of(
                EventClass.RESET_BOUNDARY, EventClass.CRITICAL, EventClass.LIFECYCLE));
        classes.put("historyLoadComplete", EnumSet.of(
                EventClass.RESET_BOUNDARY, EventClass.CRITICAL, EventClass.LIFECYCLE));
        classes.put("onStreamEnd", EnumSet.of(EventClass.CRITICAL, EventClass.LIFECYCLE));
        classes.put("onBlockReset", EnumSet.of(EventClass.CRITICAL, EventClass.LIFECYCLE));
        classes.put("onTaskEvent", EnumSet.of(EventClass.LIFECYCLE));
        return Collections.unmodifiableMap(classes);
    }

    private static boolean hasClass(JsCall<?> call, EventClass eventClass) {
        if (call.rawScript != null) {
            // A raw script carries no function name to classify, so it is
            // classified by shape: it splits a batch, and it is never the event
            // dropped to make room for another.
            return eventClass == EventClass.RESET_BOUNDARY || eventClass == EventClass.LIFECYCLE;
        }
        Set<EventClass> classes = EVENT_CLASSES.get(call.functionName);
        return classes != null && classes.contains(eventClass);
    }

    private static boolean isMessageSnapshot(JsCall<?> call) {
        return hasClass(call, EventClass.SNAPSHOT);
    }

    private static boolean isSnapshotResetBoundary(JsCall<?> call) {
        return hasClass(call, EventClass.RESET_BOUNDARY);
    }

    private boolean mergeWithTailDelta(JsCall<T> call) {
        JsCall<T> tail = pending.peekLast();
        if (tail == null || !isDelta(tail) || tail.browser != call.browser
                || !tail.functionName.equals(call.functionName)) {
            return false;
        }
        String existing = tail.args.length == 0 || tail.args[0] == null ? "" : tail.args[0];
        String incoming = call.args.length == 0 || call.args[0] == null ? "" : call.args[0];
        tail.args[0] = existing + incoming;
        return true;
    }

    private boolean mergeWithTailLatest(JsCall<T> call) {
        JsCall<T> tail = pending.peekLast();
        if (tail == null || !isLatestOnly(tail) || tail.browser != call.browser
                || !tail.functionName.equals(call.functionName)) {
            return false;
        }
        tail.args = call.args;
        return true;
    }

    private boolean dropOneDisposableEvent() {
        Iterator<JsCall<T>> iterator = pending.iterator();
        while (iterator.hasNext()) {
            if (isDisposable(iterator.next())) {
                iterator.remove();
                return true;
            }
        }
        return false;
    }

    private boolean dropOneDelta() {
        Iterator<JsCall<T>> iterator = pending.iterator();
        while (iterator.hasNext()) {
            if (isDelta(iterator.next())) {
                iterator.remove();
                return true;
            }
        }
        return false;
    }

    private void removeSupersededMessageSnapshots(JsCall<T> incoming) {
        boolean incomingTail = isTailMessageSnapshot(incoming);
        Iterator<JsCall<T>> iterator = pending.descendingIterator();
        while (iterator.hasNext()) {
            JsCall<T> candidate = iterator.next();
            // A lifecycle edge must still observe the snapshot queued before it.
            if (isLifecycle(candidate) && !isMessageSnapshot(candidate)) {
                break;
            }
            if (!isMessageSnapshot(candidate)) {
                continue;
            }
            // A later tail may start farther along the transcript. Keep earlier
            // tails unless they cover exactly the same range start; the frontend
            // needs them to fill the gap between its baseline and the new tail.
            if (!incomingTail || (isTailMessageSnapshot(candidate)
                    && incoming.args[1].equals(candidate.args[1]))) {
                iterator.remove();
            }
        }
    }

    private static boolean isTailMessageSnapshot(JsCall<?> call) {
        return hasClass(call, EventClass.SNAPSHOT_TAIL);
    }

    private static boolean isCriticalLifecycle(JsCall<?> call) {
        return hasClass(call, EventClass.CRITICAL);
    }

    /**
     * Drop the oldest event that is safe to lose so an incoming lifecycle event
     * can still be queued. Recovery events are handled by the higher-priority
     * eviction rules above.
     */
    private boolean dropOneNonLifecycle() {
        Iterator<JsCall<T>> iterator = pending.iterator();
        while (iterator.hasNext()) {
            if (!isLifecycle(iterator.next())) {
                iterator.remove();
                return true;
            }
        }
        return false;
    }

    private static boolean isLifecycle(JsCall<?> call) {
        return hasClass(call, EventClass.LIFECYCLE);
    }

    private static boolean isLatestOnly(JsCall<?> call) {
        return hasClass(call, EventClass.LATEST_ONLY);
    }

    private static boolean isDelta(JsCall<?> call) {
        return hasClass(call, EventClass.DELTA);
    }

    private static boolean isDisposable(JsCall<?> call) {
        return hasClass(call, EventClass.DISPOSABLE);
    }

    private static String[] copyArgs(String[] args) {
        return args == null ? new String[0] : args.clone();
    }

    static final class JsCall<T> {
        private final T browser;
        private final int pageGeneration;
        private final String functionName;
        private String[] args;
        private final String rawScript;
        /** Failed execution attempts, bounded by {@link #MAX_EXECUTION_RETRIES}. */
        private int executionAttempts;

        JsCall(T browser, int pageGeneration, String functionName, String[] args, String rawScript) {
            this.browser = browser;
            this.pageGeneration = pageGeneration;
            this.functionName = functionName;
            this.args = args;
            this.rawScript = rawScript;
        }

        private int estimatedChars() {
            if (rawScript != null) {
                return rawScript.length();
            }
            int length = functionName.length() + 32;
            for (String arg : args) {
                length += arg == null ? 0 : arg.length();
            }
            return length;
        }
    }
}

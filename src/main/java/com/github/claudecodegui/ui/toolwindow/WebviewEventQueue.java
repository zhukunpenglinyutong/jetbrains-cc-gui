package com.github.claudecodegui.ui.toolwindow;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.Iterator;
import java.util.List;
import java.util.function.BiConsumer;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Serializes Java-to-webview calls and keeps the pending work bounded.
 */
final class WebviewEventQueue<T> {

    private static final Logger LOG = Logger.getInstance(WebviewEventQueue.class);
    private static final int MAX_PENDING_EVENTS = 256;
    private static final int MAX_BATCH_ARGUMENT_CHARS = 256_000;

    private final Supplier<T> browserSupplier;
    private final BooleanSupplier disposedSupplier;
    private final Consumer<Runnable> scheduler;
    private final BiConsumer<T, String> scriptExecutor;
    private final Object lock = new Object();
    private final Deque<JsCall<T>> pending = new ArrayDeque<>();
    private T queuedBrowser;
    private boolean drainScheduled;
    private boolean draining;
    private boolean disposed;

    WebviewEventQueue(
            Supplier<T> browserSupplier,
            BooleanSupplier disposedSupplier,
            BiConsumer<T, String> scriptExecutor
    ) {
        this(
                browserSupplier,
                disposedSupplier,
                runnable -> ApplicationManager.getApplication().invokeLater(runnable),
                scriptExecutor
        );
    }

    WebviewEventQueue(
            Supplier<T> browserSupplier,
            BooleanSupplier disposedSupplier,
            Consumer<Runnable> scheduler,
            BiConsumer<T, String> scriptExecutor
    ) {
        this.browserSupplier = browserSupplier;
        this.disposedSupplier = disposedSupplier;
        this.scheduler = scheduler;
        this.scriptExecutor = scriptExecutor;
    }

    void enqueue(String functionName, String... args) {
        T browser = currentBrowser();
        if (browser == null) {
            return;
        }
        enqueue(new JsCall<T>(browser, functionName, copyArgs(args), null));
    }

    void enqueueRaw(String script) {
        if (script == null || script.isEmpty()) {
            return;
        }
        T browser = currentBrowser();
        if (browser == null) {
            return;
        }
        enqueue(new JsCall<T>(browser, null, new String[0], script));
    }

    void browserChanged() {
        synchronized (lock) {
            pending.clear();
            queuedBrowser = browserSupplier.get();
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

    private void enqueue(JsCall<T> call) {
        boolean scheduleDrain = false;
        synchronized (lock) {
            if (disposed || disposedSupplier.getAsBoolean()) {
                return;
            }
            if (queuedBrowser != call.browser) {
                pending.clear();
                queuedBrowser = call.browser;
            }

            if (isDelta(call) && mergeWithTailDelta(call)) {
                return;
            }
            if (isLatestOnly(call) && mergeWithTailLatest(call)) {
                return;
            }
            if (pending.size() >= MAX_PENDING_EVENTS
                    && !dropOneDisposableEvent()
                    && !dropOneDelta()
                    && !(isLifecycle(call) && dropOneNonLifecycle())) {
                LOG.warn("Dropping webview event because the bounded queue is full: "
                        + (call.functionName != null ? call.functionName : "raw"));
                return;
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

    private void drain() {
        List<JsCall<T>> batch;
        T targetBrowser;
        synchronized (lock) {
            drainScheduled = false;
            if (disposed || pending.isEmpty()) {
                return;
            }
            targetBrowser = browserSupplier.get();
            if (targetBrowser == null || targetBrowser != queuedBrowser || disposedSupplier.getAsBoolean()) {
                pending.clear();
                queuedBrowser = targetBrowser;
                return;
            }
            draining = true;
            batch = takeBatch(targetBrowser);
        }

        try {
            scriptExecutor.accept(targetBrowser, buildBatchScript(batch));
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to execute queued webview events: " + e.getMessage(), e);
        } finally {
            boolean scheduleDrain = false;
            synchronized (lock) {
                draining = false;
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

    private List<JsCall<T>> takeBatch(T targetBrowser) {
        List<JsCall<T>> batch = new ArrayList<>();
        int estimatedChars = 0;
        Iterator<JsCall<T>> iterator = pending.iterator();
        while (iterator.hasNext()) {
            JsCall<T> call = iterator.next();
            if (call.browser != targetBrowser) {
                iterator.remove();
                continue;
            }
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

    private static boolean isMessageSnapshot(JsCall<?> call) {
        return call.rawScript == null
                && ("updateMessages".equals(call.functionName)
                || "updateMessageTail".equals(call.functionName));
    }

    private static boolean isSnapshotResetBoundary(JsCall<?> call) {
        return call.rawScript != null
                || "onStreamStart".equals(call.functionName)
                || "clearMessages".equals(call.functionName);
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

    /**
     * Drop the oldest event that is safe to lose so an incoming lifecycle event
     * (stream start/end, snapshots, raw scripts) can still be queued. Without
     * this, a full queue would silently discard onStreamEnd and leave the
     * frontend stuck in the responding state.
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
        return call.rawScript != null
                || isMessageSnapshot(call)
                || isSnapshotResetBoundary(call)
                || "onStreamEnd".equals(call.functionName)
                || "onBlockReset".equals(call.functionName);
    }

    private static boolean isLatestOnly(JsCall<?> call) {
        if (call.rawScript != null) {
            return false;
        }
        return "updateStatus".equals(call.functionName)
                || "showLoading".equals(call.functionName)
                || "showThinkingStatus".equals(call.functionName)
                || "setSessionId".equals(call.functionName)
                || "onUsageUpdate".equals(call.functionName)
                || "onStreamingHeartbeat".equals(call.functionName);
    }

    private static boolean isDelta(JsCall<?> call) {
        return call.rawScript == null
                && ("onContentDelta".equals(call.functionName)
                || "onThinkingDelta".equals(call.functionName));
    }

    private static boolean isDisposable(JsCall<?> call) {
        return call.rawScript == null
                && ("updateStatus".equals(call.functionName)
                || "onUsageUpdate".equals(call.functionName)
                || "onStreamingHeartbeat".equals(call.functionName));
    }

    private static String[] copyArgs(String[] args) {
        return args == null ? new String[0] : args.clone();
    }

    static final class JsCall<T> {
        private final T browser;
        private final String functionName;
        private String[] args;
        private final String rawScript;

        JsCall(T browser, String functionName, String[] args, String rawScript) {
            this.browser = browser;
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

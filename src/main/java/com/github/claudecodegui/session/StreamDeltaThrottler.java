package com.github.claudecodegui.session;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * Batches rapid streaming deltas before forwarding them to the webview bridge.
 */
public final class StreamDeltaThrottler {

    public interface Scheduler {
        void schedule(Runnable runnable, long delayMs);

        void cancel();
    }

    private final Object lock = new Object();
    private final long intervalMs;
    private final Consumer<String> flushConsumer;
    private final Scheduler scheduler;
    private final LongSupplier nowSupplier;
    private final StringBuilder pending = new StringBuilder();
    private volatile boolean disposed;

    private long lastFlushAtMs;
    private boolean scheduled;

    public StreamDeltaThrottler(long intervalMs, Consumer<String> flushConsumer) {
        this(intervalMs, flushConsumer, new ExecutorScheduler(), System::currentTimeMillis);
    }

    StreamDeltaThrottler(
            long intervalMs,
            Consumer<String> flushConsumer,
            Scheduler scheduler,
            LongSupplier nowSupplier
    ) {
        this.intervalMs = Math.max(0L, intervalMs);
        this.flushConsumer = flushConsumer;
        this.scheduler = scheduler;
        this.nowSupplier = nowSupplier;
        this.lastFlushAtMs = nowSupplier.getAsLong();
    }

    public void append(String delta) {
        if (delta == null || delta.isEmpty()) {
            return;
        }

        final long delayMs;
        synchronized (lock) {
            pending.append(delta);
            if (scheduled) {
                return;
            }
            long elapsed = nowSupplier.getAsLong() - lastFlushAtMs;
            delayMs = Math.max(0L, intervalMs - elapsed);
            scheduled = true;
        }

        scheduler.schedule(this::flushPending, delayMs);
    }

    public void flushNow() {
        scheduler.cancel();
        flushPending();
    }

    public void reset() {
        scheduler.cancel();
        synchronized (lock) {
            scheduled = false;
            pending.setLength(0);
            lastFlushAtMs = nowSupplier.getAsLong();
        }
    }

    public void dispose() {
        disposed = true;
        reset();
        if (scheduler instanceof ExecutorScheduler) {
            ((ExecutorScheduler) scheduler).dispose();
        }
    }

    private void flushPending() {
        final String text;
        synchronized (lock) {
            scheduled = false;
            if (pending.length() == 0) {
                lastFlushAtMs = nowSupplier.getAsLong();
                return;
            }
            text = pending.toString();
            pending.setLength(0);
            lastFlushAtMs = nowSupplier.getAsLong();
        }

        if (!disposed) {
            flushConsumer.accept(text);
        }
    }

    private static final class ExecutorScheduler implements Scheduler {
        private final ScheduledExecutorService executor;
        private final AtomicReference<ScheduledFuture<?>> futureRef = new AtomicReference<>();
        private volatile boolean disposed;

        private ExecutorScheduler() {
            this.executor = Executors.newSingleThreadScheduledExecutor(new ThreadFactory() {
                @Override
                public Thread newThread(Runnable runnable) {
                    Thread thread = new Thread(runnable, "StreamDeltaThrottler");
                    thread.setDaemon(true);
                    return thread;
                }
            });
        }

        @Override
        public void schedule(Runnable runnable, long delayMs) {
            cancel();
            ScheduledFuture<?> future = executor.schedule(runnable, delayMs, TimeUnit.MILLISECONDS);
            futureRef.set(future);
        }

        @Override
        public void cancel() {
            ScheduledFuture<?> future = futureRef.getAndSet(null);
            if (future != null) {
                future.cancel(false);
            }
        }

        private void dispose() {
            if (disposed) return;
            disposed = true;
            cancel();
            executor.shutdownNow();
        }
    }
}

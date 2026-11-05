package com.github.claudecodegui.bridge;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Keeps observed descendants owned even when their parent exits or is unregistered. */
final class ManagedProcessTree {
    private static final ScheduledThreadPoolExecutor MONITOR = createMonitor();
    private static final long OBSERVATION_INTERVAL_MILLIS = 200L;
    private static final java.util.logging.Logger LOG = java.util.logging.Logger.getLogger(ManagedProcessTree.class.getName());

    private final Process process;
    private final Map<Long, ProcessHandle> descendants = new ConcurrentHashMap<>();
    private final Runnable onReleased;
    private volatile ScheduledFuture<?> monitoring;
    private boolean releaseRequested;
    private boolean released;
    private boolean observationFailed;

    ManagedProcessTree(Process process, Runnable onReleased) {
        this.process = process;
        this.onReleased = onReleased;
        captureDescendants();
        monitoring = MONITOR.scheduleWithFixedDelay(this::poll, OBSERVATION_INTERVAL_MILLIS, OBSERVATION_INTERVAL_MILLIS, TimeUnit.MILLISECONDS);
        try {
            process.onExit().thenRun(this::poll);
        } catch (UnsupportedOperationException ignored) {
            // The bounded monitor also supports Process implementations without onExit.
        }
    }

    private static ScheduledThreadPoolExecutor createMonitor() {
        ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1, task -> {
            Thread thread = new Thread(task, "ai-process-tree-monitor");
            thread.setDaemon(true);
            thread.setContextClassLoader(null);
            return thread;
        });
        executor.setRemoveOnCancelPolicy(true);
        executor.setKeepAliveTime(1L, TimeUnit.SECONDS);
        executor.allowCoreThreadTimeOut(true);
        return executor;
    }

    private void captureDescendants() {
        try {
            descendants.values().removeIf(child -> !child.isAlive());
            java.util.Set<Long> observed = new java.util.HashSet<>();
            if (process.isAlive()) {
                try (var children = process.descendants()) {
                    children.forEach(child -> {
                        observed.add(child.pid());
                        descendants.put(child.pid(), child);
                    });
                }
            }
            // The root scan is already recursive. Only scan surviving orphan roots again.
            for (ProcessHandle child : descendants.values()) {
                if (child.isAlive() && !observed.contains(child.pid())
                        && child.parent().map(parent -> !descendants.containsKey(parent.pid())).orElse(true)) {
                    try (var children = child.descendants()) {
                        children.forEach(descendant -> descendants.put(descendant.pid(), descendant));
                    }
                }
            }
            observationFailed = false;
        } catch (UnsupportedOperationException ignored) {
            // In-memory Process test doubles have no native process handle.
            observationFailed = false;
        } catch (RuntimeException error) {
            // A failed OS observation cannot establish that a process tree has exited.
            if (!observationFailed) {
                LOG.log(java.util.logging.Level.WARNING, "Unable to observe AI process descendants; retaining admission until a successful retry", error);
            }
            observationFailed = true;
        }
    }

    synchronized boolean hasLiveProcesses() {
        captureDescendants();
        return observationFailed || process.isAlive() || descendants.values().stream().anyMatch(ProcessHandle::isAlive);
    }

    synchronized boolean hasLiveDescendants() {
        captureDescendants();
        return observationFailed || descendants.values().stream().anyMatch(ProcessHandle::isAlive);
    }

    void releaseAfterExit() {
        synchronized (this) {
            releaseRequested = true;
        }
        poll();
    }

    private void poll() {
        boolean notify = false;
        synchronized (this) {
            if (released) {
                return;
            }
            if (!hasLiveProcesses() && releaseRequested) {
                released = true;
                if (monitoring != null) {
                    monitoring.cancel(false);
                }
                notify = true;
            }
        }
        if (notify) {
            onReleased.run();
        }
    }

    /** A timeout retains the permit; terminating the parent alone never proves quiescence. */
    boolean terminate(long timeoutMillis) {
        if (timeoutMillis < 0) {
            throw new IllegalArgumentException("Termination timeout must not be negative");
        }
        long started = System.nanoTime();
        long timeoutNanos = TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
        do {
            synchronized (this) {
                captureDescendants();
                for (ProcessHandle child : descendants.values()) {
                    if (child.isAlive()) {
                        child.destroyForcibly();
                    }
                }
                if (process.isAlive()) {
                    process.destroyForcibly();
                }
            }
            if (!hasLiveProcesses()) {
                break;
            }
            try {
                Thread.sleep(25L);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return false;
            }
        } while (System.nanoTime() - started < timeoutNanos);
        poll();
        return !hasLiveProcesses();
    }
}

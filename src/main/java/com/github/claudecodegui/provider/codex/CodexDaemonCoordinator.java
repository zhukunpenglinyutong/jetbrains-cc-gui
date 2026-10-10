package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.intellij.openapi.diagnostic.Logger;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Supplier;

/**
 * Owns the Codex daemon lifecycle (one long-running Node daemon per chat
 * host's bridge). Mirrors {@link com.github.claudecodegui.provider.claude.ClaudeDaemonCoordinator}
 * but routes the {@code codex.*} command surface; the app-server child lives
 * inside the daemon, so a generation here covers many native turns.
 *
 * <p>Structured {@code codex_event} daemon events are dispatched to cached
 * listeners so they survive daemon restarts (task 6.4).
 */
class CodexDaemonCoordinator {

    private static final long DAEMON_RETRY_DELAY_MS = 60_000;

    private final Logger log;
    private final Supplier<DaemonBridge> daemonFactory;

    private volatile DaemonBridge daemonBridge;
    private final Object daemonLock = new Object();
    private volatile long daemonRetryAfter = 0;
    private volatile long generationCounter = 0;
    private final List<DaemonBridge.DaemonEventListener> cachedEventListeners = new CopyOnWriteArrayList<>();

    CodexDaemonCoordinator(
            Logger log,
            NodeDetector nodeDetector,
            BridgeDirectoryResolver directoryResolver,
            EnvironmentConfigurator envConfigurator
    ) {
        this(log, () -> new DaemonBridge(nodeDetector, directoryResolver, envConfigurator));
    }

    /** Keeps test process assembly outside the browser's request surface. */
    CodexDaemonCoordinator(Logger log, Supplier<DaemonBridge> daemonFactory) {
        this.log = log;
        this.daemonFactory = daemonFactory;
    }

    /**
     * Register a listener for daemon events (notably {@code codex_event}).
     * Cached so it is re-attached after any daemon restart.
     */
    void addDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        if (listener == null) {
            return;
        }
        this.cachedEventListeners.add(listener);
        DaemonBridge current = this.daemonBridge;
        if (current != null && current.isAlive()) {
            current.addEventListener(listener);
        }
    }

    void removeDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        if (listener == null) {
            return;
        }
        this.cachedEventListeners.remove(listener);
        DaemonBridge current = this.daemonBridge;
        if (current != null && current.isAlive()) {
            current.removeEventListener(listener);
        }
    }

    /**
     * Returns the live daemon bridge, starting one if necessary. Null when the
     * daemon cannot start — the caller must fail the request rather than fall
     * back to a per-turn exec process (no silent exec downgrade, design D2).
     */
    DaemonBridge getDaemonBridge() {
        DaemonBridge current = this.daemonBridge;
        if (current != null && current.isAlive()) {
            return current;
        }
        if (System.currentTimeMillis() < this.daemonRetryAfter) {
            return null;
        }

        synchronized (this.daemonLock) {
            current = this.daemonBridge;
            if (current != null && current.isAlive()) {
                return current;
            }
            if (current != null && current.isIdleRetired() && current.ensureRunning()) {
                this.daemonRetryAfter = 0;
                return current;
            }

            this.daemonRetryAfter = System.currentTimeMillis() + DAEMON_RETRY_DELAY_MS;
            try {
                if (current != null) {
                    current.stop();
                }
                DaemonBridge newBridge = this.daemonFactory.get();
                if (newBridge.start()) {
                    this.daemonBridge = newBridge;
                    this.daemonRetryAfter = 0;
                    this.generationCounter++;
                    for (DaemonBridge.DaemonEventListener cached : this.cachedEventListeners) {
                        newBridge.addEventListener(cached);
                    }
                    this.log.info("[CodexDaemonCoordinator] Daemon bridge started, generation=" + this.generationCounter);
                    return newBridge;
                }
                this.log.warn("[CodexDaemonCoordinator] Failed to start daemon");
            } catch (Exception e) {
                this.log.warn("[CodexDaemonCoordinator] Daemon init failed: " + e.getMessage());
            }
            return null;
        }
    }

    DaemonBridge getCurrentDaemonBridge() {
        return this.daemonBridge;
    }

    /** Number of daemon generations this coordinator has produced. */
    long getGenerationCount() {
        return this.generationCounter;
    }

    /**
     * Process generation of the live daemon bridge, or -1 when it is not
     * running. Together with {@link #getGenerationCount()} this identifies the
     * exact daemon process a {@code codex_event} came from: the bridge-internal
     * counter also increments when an idle-retired or crashed daemon is
     * restarted on the SAME bridge object, which does not bump the coordinator
     * counter.
     */
    long getCurrentDaemonProcessGeneration() {
        DaemonBridge current = this.daemonBridge;
        return current != null ? current.getCurrentDaemonGeneration() : -1L;
    }

    void shutdownDaemon() {
        DaemonBridge current;
        synchronized (this.daemonLock) {
            current = this.daemonBridge;
            this.daemonBridge = null;
            this.daemonRetryAfter = 0;
        }
        if (current != null) {
            current.stop();
        }
    }
}

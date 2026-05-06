package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * Owns daemon lifecycle, retry windows, prewarm, and runtime reset operations.
 */
class ClaudeDaemonCoordinator {

    private static final long DAEMON_RETRY_DELAY_MS = 60_000;

    private final Logger log;
    private final NodeDetector nodeDetector;
    private final Supplier<BridgeDirectoryResolver> directoryResolverSupplier;
    private final EnvironmentConfigurator envConfigurator;

    private volatile DaemonBridge daemonBridge;
    private final Object daemonLock = new Object();
    private volatile long daemonRetryAfter = 0;
    private volatile CompletableFuture<?> prewarmFuture;
    // Listeners are cached so they can be re-attached when the daemon
    // restarts (a new DaemonBridge instance is created on each restart).
    private final List<DaemonBridge.DaemonEventListener> cachedEventListeners = new CopyOnWriteArrayList<>();

    ClaudeDaemonCoordinator(
            Logger log,
            NodeDetector nodeDetector,
            Supplier<BridgeDirectoryResolver> directoryResolverSupplier,
            EnvironmentConfigurator envConfigurator
    ) {
        this.log = log;
        this.nodeDetector = nodeDetector;
        this.directoryResolverSupplier = directoryResolverSupplier;
        this.envConfigurator = envConfigurator;
    }

    /**
     * Register a listener for custom daemon events. Cached so it is re-attached
     * to any future daemon bridge created after a restart.
     */
    void addDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        if (listener == null) return;
        cachedEventListeners.add(listener);
        DaemonBridge current = daemonBridge;
        if (current != null && current.isAlive()) {
            current.addEventListener(listener);
        }
    }

    /**
     * Unregister a previously added listener. No-op if not registered.
     */
    void removeDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        if (listener == null) return;
        cachedEventListeners.remove(listener);
        DaemonBridge current = daemonBridge;
        if (current != null && current.isAlive()) {
            current.removeEventListener(listener);
        }
    }

    DaemonBridge getDaemonBridge() {
        DaemonBridge current = daemonBridge;
        if (current != null && current.isAlive()) {
            return current;
        }
        if (System.currentTimeMillis() < daemonRetryAfter) {
            return null;
        }

        synchronized (daemonLock) {
            current = daemonBridge;
            if (current != null && current.isAlive()) {
                return current;
            }

            daemonRetryAfter = System.currentTimeMillis() + DAEMON_RETRY_DELAY_MS;
            try {
                if (current != null) {
                    current.stop();
                }

                DaemonBridge newBridge = new DaemonBridge(
                        nodeDetector,
                        directoryResolverSupplier.get(),
                        envConfigurator
                );
                if (newBridge.start()) {
                    daemonBridge = newBridge;
                    daemonRetryAfter = 0;
                    for (DaemonBridge.DaemonEventListener cached : cachedEventListeners) {
                        newBridge.addEventListener(cached);
                    }
                    log.info("[DaemonCoordinator] Daemon bridge started successfully");
                    return newBridge;
                }
                log.warn("[DaemonCoordinator] Failed to start daemon, using per-process mode");
            } catch (Exception e) {
                log.debug("[DaemonCoordinator] Daemon init failed: " + e.getMessage());
            }
            return null;
        }
    }

    DaemonBridge getCurrentDaemonBridge() {
        return daemonBridge;
    }

    void shutdownDaemon() {
        CompletableFuture<?> runningPrewarm = prewarmFuture;
        if (runningPrewarm != null) {
            runningPrewarm.cancel(true);
            prewarmFuture = null;
        }

        DaemonBridge current = daemonBridge;
        if (current != null) {
            current.stop();
            daemonBridge = null;
            daemonRetryAfter = 0;
        }
    }

    void prewarmDaemonAsync(String cwd, String runtimeSessionEpoch) {
        CompletableFuture<?> previous = prewarmFuture;
        if (previous != null && !previous.isDone()) {
            previous.cancel(true);
        }

        prewarmFuture = CompletableFuture.runAsync(() -> {
            try {
                DaemonBridge daemon = getDaemonBridge();
                if (daemon == null) {
                    log.info("[DaemonCoordinator] Daemon prewarm skipped (daemon unavailable)");
                    return;
                }

                JsonObject params = new JsonObject();
                params.addProperty("cwd", cwd != null ? cwd : "");
                params.addProperty("sessionId", "");
                params.addProperty("runtimeSessionEpoch", runtimeSessionEpoch != null ? runtimeSessionEpoch : "");
                params.addProperty("permissionMode", "");
                params.addProperty("model", "");
                params.addProperty("streaming", true);
                params.add("env", ClaudeBridgeUtils.buildDaemonEnv(cwd));

                CompletableFuture<Boolean> preconnectFuture = daemon.sendCommand(
                        "claude.preconnect",
                        params,
                        new DaemonBridge.DaemonOutputCallback() {
                            @Override
                            public void onLine(String line) {
                                if (line.startsWith("[SEND_ERROR]")) {
                                    log.warn("[DaemonCoordinator] Daemon preconnect error line: " + line);
                                }
                            }

                            @Override
                            public void onStderr(String text) {
                                log.debug("[DaemonCoordinator] Daemon preconnect stderr: " + text);
                            }

                            @Override
                            public void onError(String error) {
                                log.warn("[DaemonCoordinator] Daemon preconnect failed: " + error);
                            }

                            @Override
                            public void onComplete(boolean success) {
                                log.info("[DaemonCoordinator] Daemon preconnect completed: success=" + success);
                            }
                        }
                );

                preconnectFuture.get(45, TimeUnit.SECONDS);
                log.info("[DaemonCoordinator] Daemon prewarm completed for epoch="
                        + (runtimeSessionEpoch != null ? runtimeSessionEpoch : "(none)"));
            } catch (Exception e) {
                log.debug("[DaemonCoordinator] Daemon prewarm failed: " + e.getMessage());
            }
        });
    }

    void resetPersistentRuntime(String runtimeSessionEpoch) {
        DaemonBridge daemon = daemonBridge;
        if (daemon == null || !daemon.isAlive()) {
            log.info("[DaemonCoordinator] Skip runtime reset; daemon unavailable for epoch="
                    + (runtimeSessionEpoch != null ? runtimeSessionEpoch : "(none)"));
            return;
        }

        try {
            JsonObject params = new JsonObject();
            params.addProperty("runtimeSessionEpoch", runtimeSessionEpoch != null ? runtimeSessionEpoch : "");
            CompletableFuture<Boolean> resetFuture = daemon.sendCommand(
                    "claude.resetRuntime",
                    params,
                    new DaemonBridge.DaemonOutputCallback() {
                        @Override
                        public void onLine(String line) {
                            if (line != null && !line.isBlank()) {
                                log.info("[DaemonCoordinator] Runtime reset line: " + line);
                            }
                        }

                        @Override
                        public void onStderr(String text) {
                            if (text != null && !text.isBlank()) {
                                log.debug("[DaemonCoordinator] Runtime reset stderr: " + text);
                            }
                        }

                        @Override
                        public void onError(String error) {
                            log.warn("[DaemonCoordinator] Runtime reset error: " + error);
                        }

                        @Override
                        public void onComplete(boolean success) {
                            log.info("[DaemonCoordinator] Runtime reset completed: success=" + success
                                    + ", epoch=" + (runtimeSessionEpoch != null ? runtimeSessionEpoch : "(none)"));
                        }
                    }
            );
            resetFuture.get(15, TimeUnit.SECONDS);
        } catch (Exception e) {
            log.warn("[DaemonCoordinator] Runtime reset failed: " + e.getMessage());
        }
    }

}

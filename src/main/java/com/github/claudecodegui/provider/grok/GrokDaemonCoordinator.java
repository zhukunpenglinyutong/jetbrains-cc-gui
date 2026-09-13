package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Grok-specific daemon lifecycle owner (mirrors ClaudeDaemonCoordinator).
 * Dedicated instance per spec v1 (no forced sharing with Claude).
 */
class GrokDaemonCoordinator {

    private static final long DAEMON_RETRY_DELAY_MS = 60_000;

    private final Logger log;
    private final NodeDetector nodeDetector;
    private final Supplier<BridgeDirectoryResolver> directoryResolverSupplier;
    private final EnvironmentConfigurator envConfigurator;
    private final Consumer<Map<String, String>> customEnvConfigurator;

    private volatile DaemonBridge daemonBridge;
    private final Object daemonLock = new Object();
    private volatile long daemonRetryAfter = 0;
    private volatile CompletableFuture<?> prewarmFuture;
    private final List<DaemonBridge.DaemonEventListener> cachedEventListeners = new CopyOnWriteArrayList<>();

    GrokDaemonCoordinator(
            Logger log,
            NodeDetector nodeDetector,
            Supplier<BridgeDirectoryResolver> directoryResolverSupplier,
            EnvironmentConfigurator envConfigurator,
            Consumer<Map<String, String>> customEnvConfigurator
    ) {
        this.log = log;
        this.nodeDetector = nodeDetector;
        this.directoryResolverSupplier = directoryResolverSupplier;
        this.envConfigurator = envConfigurator;
        this.customEnvConfigurator = customEnvConfigurator;
    }

    void addDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        if (listener == null) { return; }
        cachedEventListeners.add(listener);
        DaemonBridge current = daemonBridge;
        if (current != null && current.isAlive()) {
            current.addEventListener(listener);
        }
    }

    void removeDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        if (listener == null) { return; }
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
                        envConfigurator,
                        customEnvConfigurator
                );
                if (newBridge.start()) {
                    daemonBridge = newBridge;
                    daemonRetryAfter = 0;
                    for (DaemonBridge.DaemonEventListener cached : cachedEventListeners) {
                        newBridge.addEventListener(cached);
                    }
                    log.info("[GrokDaemonCoordinator] Daemon bridge started successfully");
                    return newBridge;
                }
                log.warn("[GrokDaemonCoordinator] Failed to start daemon, falling back to one-shot");
            } catch (Exception e) {
                log.debug("[GrokDaemonCoordinator] Daemon init failed: " + e.getMessage());
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
        prewarmDaemonAsync(cwd, runtimeSessionEpoch, null);
    }

    void prewarmDaemonAsync(String cwd, String runtimeSessionEpoch, String sessionId) {
        CompletableFuture<?> previous = prewarmFuture;
        if (previous != null && !previous.isDone()) {
            previous.cancel(true);
        }

        prewarmFuture = CompletableFuture.runAsync(() -> {
            try {
                DaemonBridge daemon = getDaemonBridge();
                if (daemon == null) {
                    log.info("[GrokDaemonCoordinator] Prewarm skipped (daemon unavailable)");
                    return;
                }

                JsonObject params = new JsonObject();
                params.addProperty("cwd", cwd != null ? cwd : "");
                params.addProperty("sessionId", sessionId != null ? sessionId : "");
                params.addProperty("runtimeSessionEpoch", runtimeSessionEpoch != null ? runtimeSessionEpoch : "");
                // Match UI default so preconnect runtime is reused by default-mode sends
                // and tools go through the permission dialog (not a silent empty mode).
                params.addProperty("permissionMode", "default");
                params.addProperty("model", "");
                params.addProperty("streaming", true);
                // Grok env is mostly XAI_ / GROK_ ; bridge will enrich via its env config
                params.add("env", new JsonObject());

                CompletableFuture<Boolean> preconnectFuture = daemon.sendCommand(
                        "grok.preconnect",
                        params,
                        new DaemonBridge.DaemonOutputCallback() {
                            @Override
                            public void onLine(String line) {
                                if (line.startsWith("[SEND_ERROR]")) {
                                    log.warn("[GrokDaemonCoordinator] preconnect error: " + line);
                                }
                            }

                            @Override
                            public void onStderr(String text) {
                                log.debug("[GrokDaemonCoordinator] preconnect stderr: " + text);
                            }

                            @Override
                            public void onError(String error) {
                                log.warn("[GrokDaemonCoordinator] preconnect failed: " + error);
                            }

                            @Override
                            public void onComplete(boolean success) {
                                log.info("[GrokDaemonCoordinator] preconnect completed: " + success);
                            }
                        }
                );

                preconnectFuture.get(45, TimeUnit.SECONDS);
                log.info("[GrokDaemonCoordinator] prewarm completed for epoch=" +
                        (runtimeSessionEpoch != null ? runtimeSessionEpoch : "(none)"));
            } catch (Exception e) {
                log.debug("[GrokDaemonCoordinator] prewarm failed: " + e.getMessage());
            }
        });
    }

    void resetPersistentRuntime(String runtimeSessionEpoch) {
        DaemonBridge daemon = daemonBridge;
        if (daemon == null || !daemon.isAlive()) {
            log.info("[GrokDaemonCoordinator] Skip reset; daemon unavailable for epoch=" +
                    (runtimeSessionEpoch != null ? runtimeSessionEpoch : "(none)"));
            return;
        }

        try {
            JsonObject params = new JsonObject();
            params.addProperty("runtimeSessionEpoch", runtimeSessionEpoch != null ? runtimeSessionEpoch : "");
            CompletableFuture<Boolean> resetFuture = daemon.sendCommand(
                    "grok.resetRuntime",
                    params,
                    new DaemonBridge.DaemonOutputCallback() {
                        @Override
                        public void onLine(String line) {
                            if (line != null && !line.isBlank()) {
                                log.debug("[GrokDaemonCoordinator] reset line: " + line);
                            }
                        }

                        @Override
                        public void onStderr(String text) {
                            if (text != null && !text.isBlank()) {
                                log.debug("[GrokDaemonCoordinator] reset stderr: " + text);
                            }
                        }

                        @Override
                        public void onError(String error) {
                            log.warn("[GrokDaemonCoordinator] reset error: " + error);
                        }

                        @Override
                        public void onComplete(boolean success) {
                            log.info("[GrokDaemonCoordinator] reset completed: success=" + success +
                                    " epoch=" + (runtimeSessionEpoch != null ? runtimeSessionEpoch : "(none)"));
                        }
                    }
            );
            resetFuture.get(15, TimeUnit.SECONDS);
        } catch (Exception e) {
            log.warn("[GrokDaemonCoordinator] reset failed: " + e.getMessage());
        }
    }
}

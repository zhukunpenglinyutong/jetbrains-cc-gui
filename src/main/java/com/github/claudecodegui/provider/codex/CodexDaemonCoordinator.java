package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.intellij.openapi.diagnostic.Logger;

import java.util.function.Supplier;

/**
 * Owns Codex daemon lifecycle and restart backoff.
 */
class CodexDaemonCoordinator {

    private static final long DAEMON_RETRY_DELAY_MS = 60_000;

    private final Logger log;
    private final NodeDetector nodeDetector;
    private final Supplier<BridgeDirectoryResolver> directoryResolverSupplier;
    private final EnvironmentConfigurator envConfigurator;

    private volatile DaemonBridge daemonBridge;
    private final Object daemonLock = new Object();
    private volatile long daemonRetryAfter = 0;

    CodexDaemonCoordinator(
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
                    log.info("[CodexDaemonCoordinator] Daemon bridge started successfully");
                    return newBridge;
                }
                log.warn("[CodexDaemonCoordinator] Failed to start daemon, using per-process mode");
            } catch (Exception e) {
                log.debug("[CodexDaemonCoordinator] Daemon init failed: " + e.getMessage());
            }
            return null;
        }
    }

    DaemonBridge getCurrentDaemonBridge() {
        return daemonBridge;
    }

    void shutdownDaemon() {
        DaemonBridge current = daemonBridge;
        if (current != null) {
            current.stop();
            daemonBridge = null;
            daemonRetryAfter = 0;
        }
    }
}

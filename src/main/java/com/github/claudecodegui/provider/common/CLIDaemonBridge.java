package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.CLIDetector;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Manages a long-running Claude Code CLI daemon process for CLI command execution.
 *
 * This class maintains a single daemon process that handles CLI native commands
 * via NDJSON over stdin/stdout, similar to DaemonBridge but for CLI commands.
 *
 * Protocol:
 * - Java writes JSON requests to daemon's stdin (one per line)
 * - Daemon writes JSON responses to stdout (one per line, tagged with request ID)
 * - Daemon lifecycle events have type="daemon"
 * - Command output lines have an "id" field matching the request
 * - Command completion is signaled by {"id":"X","done":true}
 */
public class CLIDaemonBridge {

    private static final Logger LOG = Logger.getInstance(CLIDaemonBridge.class);
    private static final String CLI_DAEMON_SCRIPT = "cli-daemon.js";
    private static final long DAEMON_START_TIMEOUT_MS = 30_000;
    private static final long HEARTBEAT_INTERVAL_MS = 15_000;
    private static final long HEARTBEAT_TIMEOUT_MS = 45_000;
    private static final int MAX_RESTART_ATTEMPTS = 3;
    private static final long RESTART_WINDOW_MS = 30_000;

    private final CLIDetector cliDetector;
    private final BridgeDirectoryResolver directoryResolver;
    private final EnvironmentConfigurator envConfigurator;

    // Daemon process state
    private volatile Process daemonProcess;
    private volatile BufferedWriter daemonStdin;
    private volatile Thread readerThread;
    private volatile Thread heartbeatThread;
    private final AtomicBoolean isRunning = new AtomicBoolean(false);
    private final AtomicBoolean cliPreloaded = new AtomicBoolean(false);
    private final AtomicLong requestIdCounter = new AtomicLong(0);
    private volatile CountDownLatch readyLatch = new CountDownLatch(1);
    private final AtomicInteger restartAttempts = new AtomicInteger(0);
    private final AtomicLong lastSuccessfulStart = new AtomicLong(0);
    private final AtomicLong lastHeartbeatResponse = new AtomicLong(0);
    private final Object startLock = new Object();

    // Pending request handlers: requestId -> handler
    private final ConcurrentHashMap<String, RequestHandler> pendingRequests = new ConcurrentHashMap<>();

    // Lifecycle listener
    private volatile DaemonLifecycleListener lifecycleListener;

    public CLIDaemonBridge(
            CLIDetector cliDetector,
            BridgeDirectoryResolver directoryResolver,
            EnvironmentConfigurator envConfigurator
    ) {
        this.cliDetector = cliDetector;
        this.directoryResolver = directoryResolver;
        this.envConfigurator = envConfigurator;
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    /**
     * Start the daemon process. Blocks until the daemon signals "ready"
     * or the timeout expires.
     *
     * @return true if daemon started successfully
     */
    public boolean start() {
        synchronized (startLock) {
            if (isRunning.get()) {
                LOG.info("[CLIDaemonBridge] Daemon already running");
                return true;
            }

            LOG.info("[CLIDaemonBridge] Starting CLI daemon process...");
            CountDownLatch latch = new CountDownLatch(1);
            readyLatch = latch;

            try {
                File bridgeDir = directoryResolver.findSdkDir();
                if (bridgeDir == null) {
                    LOG.error("[CLIDaemonBridge] Bridge directory not found");
                    return false;
                }

                File daemonScript = new File(bridgeDir, CLI_DAEMON_SCRIPT);
                if (!daemonScript.exists()) {
                    LOG.error("[CLIDaemonBridge] cli-daemon.js not found at: " + daemonScript.getAbsolutePath());
                    return false;
                }

                String nodePath = cliDetector.getCachedNodePath();
                if (nodePath == null) {
                    // Use NodeDetector to find node
                    com.github.claudecodegui.bridge.NodeDetector nodeDetector =
                        com.github.claudecodegui.bridge.NodeDetector.getInstance();
                    nodePath = nodeDetector.findNodeExecutable();
                }

                if (nodePath == null) {
                    LOG.error("[CLIDaemonBridge] Node.js not found");
                    return false;
                }

                ProcessBuilder pb = new ProcessBuilder(nodePath, daemonScript.getAbsolutePath());
                pb.directory(bridgeDir);

                // Configure environment
                Map<String, String> env = pb.environment();
                envConfigurator.updateProcessEnvironment(pb, nodePath);

                // Set CLI path for the daemon
                String cliPath = cliDetector.getCliExecutable();
                if (cliPath != null) {
                    env.put("CLAUDE_CLI_PATH", cliPath);
                }

                // Keep stderr separate for debugging
                pb.redirectErrorStream(false);

                daemonProcess = pb.start();
                isRunning.set(true);
                lastSuccessfulStart.set(System.currentTimeMillis());

                LOG.info("[CLIDaemonBridge] CLI daemon process started, PID: " + daemonProcess.pid());

                // Setup stdin writer
                daemonStdin = new BufferedWriter(
                        new OutputStreamWriter(daemonProcess.getOutputStream(), StandardCharsets.UTF_8));

                // Start stdout reader thread
                startReaderThread();

                // Start stderr reader thread
                startStderrReaderThread();

                // Wait for "ready" event
                boolean ready = false;
                long deadline = System.currentTimeMillis() + DAEMON_START_TIMEOUT_MS;
                while (System.currentTimeMillis() < deadline) {
                    if (latch.await(200, TimeUnit.MILLISECONDS)) {
                        ready = true;
                        break;
                    }
                    if (daemonProcess == null || !daemonProcess.isAlive() || !isRunning.get()) {
                        LOG.error("[CLIDaemonBridge] Daemon exited before signaling ready");
                        isRunning.set(false);
                        return false;
                    }
                }

                if (!ready) {
                    LOG.warn("[CLIDaemonBridge] Daemon did not signal ready within timeout");
                    if (daemonProcess == null || !daemonProcess.isAlive() || !isRunning.get()) {
                        LOG.error("[CLIDaemonBridge] Daemon is not alive after ready timeout");
                        isRunning.set(false);
                        return false;
                    }
                }

                // Start heartbeat thread
                startHeartbeatThread();

                LOG.info("[CLIDaemonBridge] CLI daemon is ready. CLI preloaded: " + cliPreloaded.get());
                return true;

            } catch (Exception e) {
                LOG.error("[CLIDaemonBridge] Failed to start daemon", e);
                isRunning.set(false);
                return false;
            }
        }
    }

    /**
     * Stop the daemon process gracefully.
     */
    public void stop() {
        LOG.info("[CLIDaemonBridge] Stopping CLI daemon...");
        isRunning.set(false);

        // Cancel all pending requests
        for (Map.Entry<String, RequestHandler> entry : pendingRequests.entrySet()) {
            entry.getValue().onError("Daemon stopped");
        }
        pendingRequests.clear();

        // Send shutdown command
        try {
            if (daemonStdin != null) {
                JsonObject shutdown = new JsonObject();
                shutdown.addProperty("id", "shutdown");
                shutdown.addProperty("method", "shutdown");
                synchronized (daemonStdin) {
                    daemonStdin.write(shutdown.toString());
                    daemonStdin.newLine();
                    daemonStdin.flush();
                }
            }
        } catch (IOException e) {
            LOG.debug("[CLIDaemonBridge] Error sending shutdown command: " + e.getMessage());
        }

        // Close stdin
        try {
            if (daemonStdin != null) {
                daemonStdin.close();
            }
        } catch (IOException e) {
            LOG.debug("[CLIDaemonBridge] Error closing stdin: " + e.getMessage());
        }

        // Kill process if still alive
        if (daemonProcess != null && daemonProcess.isAlive()) {
            daemonProcess.destroyForcibly();
            try { daemonProcess.waitFor(3, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }

        // Interrupt and join threads
        if (readerThread != null) {
            readerThread.interrupt();
            try { readerThread.join(2000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
        if (heartbeatThread != null) {
            heartbeatThread.interrupt();
            try { heartbeatThread.join(2000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }

        LOG.info("[CLIDaemonBridge] CLI daemon stopped");
    }

    /**
     * Send an abort command to cancel the currently executing request.
     */
    public void sendAbort() {
        try {
            if (daemonStdin != null && isRunning.get()) {
                JsonObject abort = new JsonObject();
                abort.addProperty("id", "abort-" + System.currentTimeMillis());
                abort.addProperty("method", "abort");
                synchronized (daemonStdin) {
                    daemonStdin.write(abort.toString());
                    daemonStdin.newLine();
                    daemonStdin.flush();
                }
                LOG.info("[CLIDaemonBridge] Sent abort command");
            }
        } catch (IOException e) {
            LOG.debug("[CLIDaemonBridge] Error sending abort command: " + e.getMessage());
        }

        // Complete all pending request futures
        for (Map.Entry<String, RequestHandler> entry : pendingRequests.entrySet()) {
            entry.getValue().onError("Request aborted by user");
            entry.getValue().future.complete(false);
        }
        pendingRequests.clear();
    }

    /**
     * Check if the daemon is running and healthy.
     */
    public boolean isAlive() {
        return isRunning.get() && daemonProcess != null && daemonProcess.isAlive();
    }

    /**
     * Ensure the daemon is running, starting it if necessary.
     */
    public boolean ensureRunning() {
        if (isAlive()) return true;
        return start();
    }

    // =========================================================================
    // Request Execution
    // =========================================================================

    /**
     * Send a command to the daemon and process output lines via callback.
     *
     * @param method   Command method (e.g., "cli.execute")
     * @param params   Command parameters (JSON object)
     * @param callback Callback for processing output lines
     * @return CompletableFuture that completes when the command finishes
     */
    public CompletableFuture<Boolean> sendCommand(
            String method,
            JsonObject params,
            DaemonOutputCallback callback
    ) {
        if (!ensureRunning()) {
            CompletableFuture<Boolean> f = new CompletableFuture<>();
            f.completeExceptionally(new IOException("Daemon not running"));
            return f;
        }

        String requestId = String.valueOf(requestIdCounter.incrementAndGet());
        CompletableFuture<Boolean> future = new CompletableFuture<>();

        RequestHandler handler = new RequestHandler(callback, future);
        pendingRequests.put(requestId, handler);

        // Ensure cleanup when future completes
        future.whenComplete((result, ex) -> pendingRequests.remove(requestId));

        // Build request JSON
        JsonObject request = new JsonObject();
        request.addProperty("id", requestId);
        request.addProperty("method", method);
        request.add("params", params);

        try {
            synchronized (daemonStdin) {
                daemonStdin.write(request.toString());
                daemonStdin.newLine();
                daemonStdin.flush();
            }
            LOG.info("[CLIDaemonBridge] Sent request " + requestId + ": " + method);
        } catch (IOException e) {
            pendingRequests.remove(requestId);
            future.completeExceptionally(e);
            LOG.error("[CLIDaemonBridge] Failed to send request: " + e.getMessage());
        }

        return future;
    }

    // =========================================================================
    // Reader Threads
    // =========================================================================

    private void startReaderThread() {
        readerThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(daemonProcess.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    handleDaemonOutput(line);
                }
            } catch (IOException e) {
                if (isRunning.get()) {
                    LOG.error("[CLIDaemonBridge] Reader thread error: " + e.getMessage());
                }
            } finally {
                handleDaemonDeath();
            }
        }, "CLIDaemonBridge-Reader");
        readerThread.setDaemon(true);
        readerThread.start();
    }

    private void startStderrReaderThread() {
        Thread stderrThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(daemonProcess.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    LOG.debug("[CLIDaemonBridge:stderr] " + line);
                }
            } catch (IOException e) {
                // Expected on shutdown
            }
        }, "CLIDaemonBridge-Stderr");
        stderrThread.setDaemon(true);
        stderrThread.start();
    }

    private void startHeartbeatThread() {
        lastHeartbeatResponse.set(System.currentTimeMillis());

        heartbeatThread = new Thread(() -> {
            while (isRunning.get()) {
                try {
                    Thread.sleep(HEARTBEAT_INTERVAL_MS);
                    if (!isAlive()) break;

                    // Check if daemon is unresponsive
                    long elapsed = System.currentTimeMillis() - lastHeartbeatResponse.get();
                    if (elapsed > HEARTBEAT_TIMEOUT_MS) {
                        LOG.warn("[CLIDaemonBridge] Daemon unresponsive (no heartbeat for "
                                + elapsed + "ms), treating as dead");
                        handleDaemonDeath();
                        break;
                    }

                    // Send heartbeat
                    JsonObject hb = new JsonObject();
                    hb.addProperty("id", "hb-" + System.currentTimeMillis());
                    hb.addProperty("method", "heartbeat");
                    synchronized (daemonStdin) {
                        daemonStdin.write(hb.toString());
                        daemonStdin.newLine();
                        daemonStdin.flush();
                    }
                } catch (InterruptedException e) {
                    break;
                } catch (IOException e) {
                    LOG.warn("[CLIDaemonBridge] Heartbeat failed: " + e.getMessage());
                    handleDaemonDeath();
                    break;
                }
            }
        }, "CLIDaemonBridge-Heartbeat");
        heartbeatThread.setDaemon(true);
        heartbeatThread.start();
    }

    // =========================================================================
    // Output Parsing
    // =========================================================================

    private void handleDaemonOutput(String jsonLine) {
        // Skip non-JSON lines
        String trimmed = jsonLine.trim();
        if (trimmed.isEmpty() || trimmed.charAt(0) != '{') {
            LOG.debug("[CLIDaemonBridge] Non-JSON output: " + trimmed);
            return;
        }

        try {
            JsonElement element = JsonParser.parseString(trimmed);
            if (!element.isJsonObject()) return;
            JsonObject obj = element.getAsJsonObject();

            // Daemon lifecycle events
            if (obj.has("type")) {
                String type = obj.get("type").getAsString();

                if ("daemon".equals(type)) {
                    handleDaemonEvent(obj);
                    return;
                }

                if ("heartbeat".equals(type)) {
                    lastHeartbeatResponse.set(System.currentTimeMillis());
                    return;
                }

                if ("status".equals(type)) {
                    return;
                }
            }

            // Request-tagged output
            if (!obj.has("id")) return;
            String id = obj.get("id").getAsString();

            if (id.startsWith("hb-")) return;

            RequestHandler handler = pendingRequests.get(id);
            if (handler == null) {
                LOG.debug("[CLIDaemonBridge] No handler for request " + id);
                return;
            }

            // Command completion
            if (obj.has("done")) {
                boolean success = obj.has("success") && obj.get("success").getAsBoolean();
                if (!success && obj.has("error")) {
                    handler.onError(obj.get("error").getAsString());
                }
                handler.onComplete(success);
                pendingRequests.remove(id);
                return;
            }

            // Output line from the command
            if (obj.has("line")) {
                handler.callback.onLine(obj.get("line").getAsString());
                return;
            }

            // Stderr output
            if (obj.has("stderr")) {
                handler.callback.onStderr(obj.get("stderr").getAsString());
            }

        } catch (Exception e) {
            LOG.error("[CLIDaemonBridge] Failed to parse daemon output: " + jsonLine, e);
        }
    }

    private void handleDaemonEvent(JsonObject obj) {
        String event = obj.has("event") ? obj.get("event").getAsString() : "unknown";
        LOG.info("[CLIDaemonBridge] Daemon event: " + event);

        switch (event) {
            case "ready":
                if (obj.has("cliPreloaded")) {
                    cliPreloaded.set(obj.get("cliPreloaded").getAsBoolean());
                }
                readyLatch.countDown();
                if (lifecycleListener != null) {
                    lifecycleListener.onDaemonReady();
                }
                break;

            case "cli_loaded":
                cliPreloaded.set(true);
                LOG.info("[CLIDaemonBridge] CLI pre-loaded successfully");
                break;

            case "cli_load_error":
                String error = obj.has("error") ? obj.get("error").getAsString() : "unknown";
                LOG.warn("[CLIDaemonBridge] CLI pre-load failed: " + error);
                break;

            case "shutdown":
                LOG.info("[CLIDaemonBridge] Daemon shutting down");
                break;

            default:
                LOG.debug("[CLIDaemonBridge] Unhandled daemon event: " + event);
        }
    }

    // =========================================================================
    // Daemon Death & Auto-Restart
    // =========================================================================

    private void handleDaemonDeath() {
        if (!isRunning.compareAndSet(true, false)) return;

        LOG.warn("[CLIDaemonBridge] Daemon process died");

        // Forcefully kill the old process if still alive
        Process oldProcess = daemonProcess;
        if (oldProcess != null && oldProcess.isAlive()) {
            LOG.info("[CLIDaemonBridge] Forcefully killing unresponsive daemon (PID: "
                    + oldProcess.pid() + ")");
            oldProcess.destroyForcibly();
            try { oldProcess.waitFor(2, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }

        // Fail all pending requests
        for (Map.Entry<String, RequestHandler> entry : pendingRequests.entrySet()) {
            entry.getValue().onError("Daemon process died unexpectedly");
        }
        pendingRequests.clear();

        // Notify listener
        if (lifecycleListener != null) {
            lifecycleListener.onDaemonDied();
        }

        // Auto-restart if within limit
        long uptime = System.currentTimeMillis() - lastSuccessfulStart.get();
        if (uptime > RESTART_WINDOW_MS) {
            restartAttempts.set(0);
        }

        int attempts = restartAttempts.incrementAndGet();
        if (attempts <= MAX_RESTART_ATTEMPTS) {
            LOG.info("[CLIDaemonBridge] Attempting restart (" + attempts + "/" + MAX_RESTART_ATTEMPTS
                    + ", last uptime=" + uptime + "ms)");
            start();
        } else {
            LOG.error("[CLIDaemonBridge] Max restart attempts reached (" + attempts
                    + " within " + RESTART_WINDOW_MS + "ms window). Daemon will not be restarted.");
        }
    }

    // =========================================================================
    // Setters
    // =========================================================================

    public void setLifecycleListener(DaemonLifecycleListener listener) {
        this.lifecycleListener = listener;
    }

    public boolean isCliPreloaded() {
        return cliPreloaded.get();
    }

    // =========================================================================
    // Inner Types
    // =========================================================================

    /**
     * Callback interface for receiving daemon output.
     */
    public interface DaemonOutputCallback {
        void onLine(String line);
        void onStderr(String text);
        void onError(String error);
        void onComplete(boolean success);
    }

    /**
     * Lifecycle listener for daemon events.
     */
    public interface DaemonLifecycleListener {
        void onDaemonReady();
        void onDaemonDied();
    }

    /**
     * Internal handler that wraps callback + future for a pending request.
     */
    private static class RequestHandler {
        final DaemonOutputCallback callback;
        final CompletableFuture<Boolean> future;

        RequestHandler(DaemonOutputCallback callback, CompletableFuture<Boolean> future) {
            this.callback = callback;
            this.future = future;
        }

        void onError(String error) {
            callback.onError(error);
        }

        void onComplete(boolean success) {
            callback.onComplete(success);
            future.complete(success);
        }
    }
}

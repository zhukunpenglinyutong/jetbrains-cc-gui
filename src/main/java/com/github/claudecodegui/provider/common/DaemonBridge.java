package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.ClaudeCliPathHandler;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.diagnostic.Logger;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/**
 * Manages a long-running Node.js daemon process for AI SDK communication.
 *
 * Instead of spawning a new Node.js process per request (which adds ~5-10s of
 * overhead due to SDK loading), this class maintains a single daemon process
 * that pre-loads the SDK once and handles multiple requests via NDJSON over stdin/stdout.
 *
 * Protocol:
 * - Java writes JSON requests to daemon's stdin (one per line)
 * - Daemon writes JSON responses to stdout (one per line, tagged with request ID)
 * - Daemon lifecycle events have type="daemon"
 * - Command output lines have an "id" field matching the request
 * - Command completion is signaled by {"id":"X","done":true}
 */
public class DaemonBridge {

    private static final Logger LOG = Logger.getInstance(DaemonBridge.class);
    private static final String DAEMON_SCRIPT = "daemon.js";
    private static final long DAEMON_START_TIMEOUT_MS = 30_000;
    private static final long HEARTBEAT_INTERVAL_MS = 15_000;
    private static final long HEARTBEAT_TIMEOUT_MS = 45_000; // 3 missed heartbeats = dead
    private static final long ACTIVE_REQUEST_HEARTBEAT_TIMEOUT_MS = 180_000;
    private static final long HEARTBEAT_PROBE_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2;
    private static final long HEARTBEAT_SCHEDULER_GAP_MS = HEARTBEAT_INTERVAL_MS + 5_000;
    private static final int MAX_RESTART_ATTEMPTS = 3;
    private static final long RESTART_WINDOW_MS = 30_000; // Reset restart counter after this period of stability
    private static final int STDERR_RING_CAPACITY = 40;

    private final NodeDetector nodeDetector;
    private final BridgeDirectoryResolver directoryResolver;
    private final EnvironmentConfigurator envConfigurator;
    private final TimeSource timeSource;
    private final DaemonProcessLauncher processLauncher;
    private final DaemonLifecycleHooks lifecycleHooks;
    private final long heartbeatIntervalMs;
    private final Consumer<Map<String, String>> customEnvConfigurator;
    // Daemon process state. Every asynchronous callback is scoped to one context.
    private volatile DaemonGenerationContext daemonContext;
    private final AtomicLong daemonGenerationCounter = new AtomicLong(0);
    // Guarded by startLock. Explicit stop intent always outranks auto-restart.
    private boolean restartInProgress;
    private boolean desiredRunning;
    private long stopEpoch;
    private final AtomicLong startAttemptCounter = new AtomicLong(0);
    private StartAttempt activeStartAttempt;
    private final AtomicLong requestIdCounter = new AtomicLong(0);
    private final AtomicInteger restartAttempts = new AtomicInteger(0);
    private final Object startLock = new Object();

    // Lifecycle listener
    private volatile DaemonLifecycleListener lifecycleListener;

    // Event listeners for custom daemon events. CopyOnWriteArrayList allows safe
    // iteration during dispatch while listeners may be added/removed concurrently.
    private final List<DaemonEventListener> eventListeners = new CopyOnWriteArrayList<>();

    public DaemonBridge(
            NodeDetector nodeDetector,
            BridgeDirectoryResolver directoryResolver,
            EnvironmentConfigurator envConfigurator
    ) {
        this(nodeDetector, directoryResolver, envConfigurator, (Consumer<Map<String, String>>) null);
    }

    public DaemonBridge(
            NodeDetector nodeDetector,
            BridgeDirectoryResolver directoryResolver,
            EnvironmentConfigurator envConfigurator,
            Consumer<Map<String, String>> customEnvConfigurator
    ) {
        this(nodeDetector, directoryResolver, envConfigurator, TimeSource.system(), null, null, HEARTBEAT_INTERVAL_MS, customEnvConfigurator);
    }

    DaemonBridge(
            NodeDetector nodeDetector,
            BridgeDirectoryResolver directoryResolver,
            EnvironmentConfigurator envConfigurator,
            TimeSource timeSource
    ) {
        this(nodeDetector, directoryResolver, envConfigurator, timeSource, null, null);
    }

    DaemonBridge(
            NodeDetector nodeDetector,
            BridgeDirectoryResolver directoryResolver,
            EnvironmentConfigurator envConfigurator,
            TimeSource timeSource,
            DaemonProcessLauncher processLauncher,
            DaemonLifecycleHooks lifecycleHooks
    ) {
        this(
                nodeDetector,
                directoryResolver,
                envConfigurator,
                timeSource,
                processLauncher,
                lifecycleHooks,
                HEARTBEAT_INTERVAL_MS,
                null);
    }

    DaemonBridge(
            NodeDetector nodeDetector,
            BridgeDirectoryResolver directoryResolver,
            EnvironmentConfigurator envConfigurator,
            TimeSource timeSource,
            DaemonProcessLauncher processLauncher,
            DaemonLifecycleHooks lifecycleHooks,
            long heartbeatIntervalMs,
            Consumer<Map<String, String>> customEnvConfigurator
    ) {
        this.nodeDetector = nodeDetector;
        this.directoryResolver = directoryResolver;
        this.envConfigurator = envConfigurator;
        this.timeSource = timeSource;
        this.processLauncher = processLauncher != null
                ? processLauncher : this::launchConfiguredDaemon;
        this.lifecycleHooks = lifecycleHooks != null
                ? lifecycleHooks : DaemonLifecycleHooks.NO_OP;
        this.heartbeatIntervalMs = heartbeatIntervalMs;
        this.customEnvConfigurator = customEnvConfigurator;
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
        StartAttempt attempt;
        boolean ownsAttempt;
        synchronized (startLock) {
            if (activeStartAttempt != null) {
                attempt = activeStartAttempt;
                ownsAttempt = false;
            } else {
                DaemonGenerationContext existingContext = daemonContext;
                if (existingContext != null && existingContext.isActive()) {
                    if (existingContext.isStartupPublished()
                            && existingContext.process.isAlive()) {
                        LOG.info("[DaemonBridge] Daemon already running");
                        return true;
                    }
                    LOG.info("[DaemonBridge] Existing daemon generation still owns lifecycle "
                            + "cleanup; refusing to replace generation="
                            + existingContext.generation);
                    return false;
                }
                if (restartInProgress) {
                    LOG.info("[DaemonBridge] Daemon restart cleanup is still in progress");
                    return false;
                }
                desiredRunning = true;
                attempt = reserveStartAttemptLocked();
                ownsAttempt = true;
            }
        }
        return ownsAttempt ? executeStartAttempt(attempt) : attempt.awaitResult();
    }

    private StartAttempt reserveStartAttemptLocked() {
        StartAttempt attempt = new StartAttempt(
                startAttemptCounter.incrementAndGet(), stopEpoch);
        activeStartAttempt = attempt;
        return attempt;
    }

    private boolean executeStartAttempt(StartAttempt attempt) {
        DaemonGenerationContext startedContext = null;
        Process startedProcess = null;
        try {
            synchronized (startLock) {
                if (!isStartAttemptCurrentLocked(attempt)) {
                    attempt.complete(false);
                    return false;
                }
            }

            startedProcess = processLauncher.launch();
            BufferedWriter startedStdin = new BufferedWriter(
                    new OutputStreamWriter(startedProcess.getOutputStream(), StandardCharsets.UTF_8));
            long startedGeneration = daemonGenerationCounter.incrementAndGet();
            long startedWallTime = timeSource.currentTimeMillis();
            long startedNanos = timeSource.nanoTime();
            startedContext = new DaemonGenerationContext(
                    startedProcess,
                    startedStdin,
                    startedGeneration,
                    startedWallTime,
                    startedNanos);

            synchronized (startLock) {
                if (!isStartAttemptCurrentLocked(attempt)) {
                    startedContext.stop();
                    destroyProcess(startedProcess);
                    attempt.complete(false);
                    return false;
                }
                daemonContext = startedContext;
                attempt.context = startedContext;
            }

            LOG.info("[DaemonBridge] Daemon process started, PID: " + startedProcess.pid()
                    + ", generation=" + startedGeneration
                    + ", startAttempt=" + attempt.id);

            startReaderThread(startedContext);
            startStderrReaderThread(startedContext);

            boolean ready = awaitDaemonReady(attempt, startedContext);
            if (!ready) {
                String failurePhase = startedProcess.isAlive()
                        ? "ready_timeout" : "exited_before_ready";
                logDaemonStartupFailure(startedContext, failurePhase);
                LOG.warn("[DaemonBridge] Daemon failed to signal ready for startAttempt="
                        + attempt.id);
                failStartAttempt(attempt, startedContext, startedProcess);
                return false;
            }

            startHeartbeatThread(startedContext);
            synchronized (startLock) {
                if (!isStartAttemptCurrentLocked(attempt)
                        || daemonContext != startedContext
                        || !startedContext.isActive()
                        || !startedProcess.isAlive()) {
                    failStartAttemptLocked(attempt, startedContext);
                    destroyProcess(startedProcess);
                    return false;
                }
                startedContext.publishStartup();
                activeStartAttempt = null;
                attempt.complete(true);
            }

            LOG.info("[DaemonBridge] Daemon is ready. SDK preloaded: "
                    + startedContext.sdkPreloaded.get());
            return true;
        } catch (Exception e) {
            LOG.error("[DaemonBridge] Failed to start daemon", e);
            failStartAttempt(attempt, startedContext, startedProcess);
            return false;
        }
    }

    private boolean awaitDaemonReady(
            StartAttempt attempt,
            DaemonGenerationContext context
    ) throws InterruptedException {
        long startWaitNanos = timeSource.nanoTime();
        while (elapsedMillis(timeSource.nanoTime(), startWaitNanos)
                < DAEMON_START_TIMEOUT_MS) {
            if (context.readyLatch.await(200, TimeUnit.MILLISECONDS)) {
                return context.isActive() && context.process.isAlive();
            }
            synchronized (startLock) {
                if (!isStartAttemptCurrentLocked(attempt)
                        || daemonContext != context
                        || !context.isActive()
                        || !context.process.isAlive()) {
                    return false;
                }
            }
        }
        return false;
    }

    private void failStartAttempt(
            StartAttempt attempt,
            DaemonGenerationContext context,
            Process process
    ) {
        synchronized (startLock) {
            failStartAttemptLocked(attempt, context);
        }
        destroyProcess(process);
    }

    private void failStartAttemptLocked(
            StartAttempt attempt,
            DaemonGenerationContext context
    ) {
        if (context != null && !context.isStartupPublished()) {
            context.stop();
        }
        if (activeStartAttempt == attempt) {
            activeStartAttempt = null;
            if (stopEpoch == attempt.stopEpoch) {
                desiredRunning = false;
            }
        }
        attempt.complete(false);
    }

    private boolean isStartAttemptCurrentLocked(StartAttempt attempt) {
        return desiredRunning
                && stopEpoch == attempt.stopEpoch
                && activeStartAttempt == attempt
                && !attempt.isCancelled();
    }

    private static void destroyProcess(Process process) {
        if (process != null && process.isAlive()) {
            process.destroyForcibly();
        }
    }

    private Process launchConfiguredDaemon() throws IOException {
        File bridgeDir = directoryResolver.findSdkDir();
        if (bridgeDir == null) {
            throw new IOException("Bridge directory not found");
        }

        File daemonScript = new File(bridgeDir, DAEMON_SCRIPT);
        if (!daemonScript.exists()) {
            throw new IOException("daemon.js not found at: " + daemonScript.getAbsolutePath());
        }

        String nodePath = nodeDetector.findNodeExecutable();
        if (nodePath == null) {
            throw new IOException("Node.js not found");
        }

        List<String> daemonCmd = NodeDetector.buildNodeScriptCommand(
                nodePath, daemonScript.getAbsolutePath());
        ProcessBuilder processBuilder = new ProcessBuilder(daemonCmd);
        processBuilder.directory(bridgeDir);
        envConfigurator.updateProcessEnvironment(processBuilder, nodePath);
        if (customEnvConfigurator != null) {
            customEnvConfigurator.accept(processBuilder.environment());
        }

        Map<String, String> environment = processBuilder.environment();
        String claudeCliPath = PropertiesComponent.getInstance()
                .getValue(ClaudeCliPathHandler.CLAUDE_CLI_PATH_PROPERTY_KEY);
        if (claudeCliPath != null && !claudeCliPath.trim().isEmpty()) {
            environment.put("CLAUDE_CODE_PATH", claudeCliPath.trim());
            LOG.info("[DaemonBridge] Using custom Claude CLI: " + claudeCliPath.trim());
        }

        processBuilder.redirectErrorStream(false);
        Process process = processBuilder.start();
        LOG.info("[DaemonBridge] Daemon process launched, PID: " + process.pid()
                + ", cmd: " + String.join(" ", daemonCmd)
                + ", cwd: " + bridgeDir.getAbsolutePath());
        return process;
    }

    /**
     * Stop the daemon process gracefully.
     */
    public void stop() {
        LOG.info("[DaemonBridge] Stopping daemon...");
        DaemonGenerationContext context;
        synchronized (startLock) {
            desiredRunning = false;
            stopEpoch++;
            StartAttempt startAttempt = activeStartAttempt;
            activeStartAttempt = null;
            if (startAttempt != null) {
                startAttempt.cancel();
            }
            context = daemonContext;
            if (context != null) {
                context.stop();
            }
        }
        if (context == null) {
            return;
        }

        // Cancel all pending requests
        for (RequestHandler handler : context.drainRequests()) {
            handler.onError("Daemon stopped");
        }

        // Send shutdown command before closing stdin (allows daemon to flush)
        try {
            JsonObject shutdown = new JsonObject();
            shutdown.addProperty("id", "shutdown");
            shutdown.addProperty("method", "shutdown");
            synchronized (context.stdin) {
                context.stdin.write(shutdown.toString());
                context.stdin.newLine();
                context.stdin.flush();
            }
        } catch (IOException e) {
            LOG.debug("[DaemonBridge] Error sending shutdown command: " + e.getMessage());
        }

        // Close stdin (triggers daemon shutdown if command wasn't received)
        try {
            context.stdin.close();
        } catch (IOException e) {
            LOG.debug("[DaemonBridge] Error closing stdin: " + e.getMessage());
        }

        // Kill process if still alive and wait for termination
        if (context.process.isAlive()) {
            context.process.destroyForcibly();
            try {
                context.process.waitFor(3, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        // Interrupt and join threads
        if (context.readerThread != null && context.readerThread != Thread.currentThread()) {
            context.readerThread.interrupt();
            try {
                context.readerThread.join(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        if (context.heartbeatThread != null && context.heartbeatThread != Thread.currentThread()) {
            context.heartbeatThread.interrupt();
            try {
                context.heartbeatThread.join(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        LOG.info("[DaemonBridge] Daemon stopped");
    }

    /**
     * Send an abort command to cancel the currently executing request.
     * The abort bypasses the daemon's command queue and is processed immediately.
     * Also completes all pending request futures so Java-side blocking calls unblock.
     */
    public void sendAbort() {
        DaemonGenerationContext context = daemonContext;
        // Send abort command to daemon so it stops the active SDK query
        try {
            if (context != null && context.isActive()) {
                JsonObject abort = new JsonObject();
                abort.addProperty("id", "abort-" + System.currentTimeMillis());
                abort.addProperty("method", "abort");
                synchronized (context.stdin) {
                    context.stdin.write(abort.toString());
                    context.stdin.newLine();
                    context.stdin.flush();
                }
                LOG.info("[DaemonBridge] Sent abort command");
            }
        } catch (IOException e) {
            LOG.debug("[DaemonBridge] Error sending abort command: " + e.getMessage());
        }

        // Complete all pending request futures so Java-side callers unblock.
        // Use onComplete(false) instead of onError() so that user-initiated aborts
        // are treated as a normal (unsuccessful) completion rather than an error,
        // matching the graceful handling that Codex uses.
        if (context != null) {
            for (RequestHandler handler : context.drainRequests()) {
                handler.onAbort();
            }
        }
    }

    /**
     * Check if the daemon is running and healthy.
     */
    public boolean isAlive() {
        DaemonGenerationContext context = daemonContext;
        return context != null && context.isStartupPublished()
                && context.isActive() && context.process.isAlive();
    }

    /**
     * Returns the underlying daemon Process for inspection by NodeProcessRegistry.
     * May be null when no daemon is running. Callers must NOT destroy/kill through
     * this reference — always go through stop() to keep state consistent.
     */
    public Process getDaemonProcessForInspection() {
        DaemonGenerationContext context = daemonContext;
        return context != null ? context.process : null;
    }

    /**
     * Returns the number of in-flight requests currently being processed by the daemon.
     * Used by the management panel to indicate daemon load.
     */
    public int getActiveRequestCount() {
        DaemonGenerationContext context = daemonContext;
        return context != null ? context.activeRequestCount.get() : 0;
    }

    /**
     * Ensure the daemon is running, starting it if necessary.
     */
    public boolean ensureRunning() {
        if (isAlive()) { return true; }
        return start();
    }

    // =========================================================================
    // Request Execution
    // =========================================================================

    /**
     * Send a command to the daemon and process output lines via callback.
     *
     * This method is non-blocking. Output lines are delivered to the callback
     * as they arrive from the daemon. The returned future completes when the
     * daemon signals "done" for this request.
     *
     * @param method   Command method (e.g., "claude.send")
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
        DaemonGenerationContext context = daemonContext;
        if (context == null || !context.isActive() || !context.process.isAlive()) {
            CompletableFuture<Boolean> f = new CompletableFuture<>();
            f.completeExceptionally(new IOException("Daemon generation changed before request"));
            return f;
        }

        String requestId = String.valueOf(requestIdCounter.incrementAndGet());
        CompletableFuture<Boolean> future = new CompletableFuture<>();
        boolean countsAsActiveRequest = !"heartbeat".equals(method) && !"status".equals(method);

        RequestHandler handler = new RequestHandler(callback, future);
        if (!context.registerRequest(requestId, handler, countsAsActiveRequest, timeSource)) {
            future.completeExceptionally(new IOException("Daemon generation is no longer active"));
            return future;
        }

        // Ensure cleanup when future completes (e.g., via timeout or cancellation)
        future.whenComplete((result, ex) -> context.removeRequest(requestId));

        // Build request JSON
        JsonObject request = new JsonObject();
        request.addProperty("id", requestId);
        request.addProperty("method", method);
        request.add("params", params);

        try {
            synchronized (context.stdin) {
                if (!context.isActive()) {
                    throw new IOException("Daemon generation changed before write");
                }
                context.stdin.write(request.toString());
                context.stdin.newLine();
                context.stdin.flush();
            }
            LOG.info("[DaemonBridge] Sent request " + requestId + ": " + method);
        } catch (IOException e) {
            context.removeRequest(requestId);
            future.completeExceptionally(e);
            LOG.error("[DaemonBridge] Failed to send request: " + e.getMessage());
        }

        return future;
    }

    // =========================================================================
    // Reader Threads
    // =========================================================================

    private void startReaderThread(DaemonGenerationContext context) {
        context.readerThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(context.process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (!isCurrentDaemon(context) || !context.isActive()) {
                        break;
                    }
                    handleDaemonOutput(line, context);
                }
            } catch (IOException e) {
                if (isCurrentDaemon(context) && context.isActive()) {
                    LOG.error("[DaemonBridge] Reader thread error: " + e.getMessage());
                }
            } finally {
                handleDaemonDeath(context, null);
            }
        }, "DaemonBridge-Reader");
        context.readerThread.setDaemon(true);
        context.readerThread.start();
    }

    private void startStderrReaderThread(DaemonGenerationContext context) {
        Thread stderrThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(context.process.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (!shouldRecordStderrLine(daemonContext, context)) {
                        break;
                    }
                    context.appendStderrLine(line);
                    LOG.debug("[DaemonBridge:stderr] generation="
                            + context.generation + " " + line);
                }
            } catch (IOException e) {
                // Expected on shutdown
            }
        }, "DaemonBridge-Stderr");
        stderrThread.setDaemon(true);
        stderrThread.start();
    }

    private void startHeartbeatThread(DaemonGenerationContext context) {
        IdleHeartbeatProbeState heartbeatProbeState = new IdleHeartbeatProbeState();
        heartbeatProbeState.reset(timeSource.currentTimeMillis());

        context.heartbeatThread = new Thread(() -> {
            while (context.isActive() && isCurrentDaemon(context)) {
                try {
                    Thread.sleep(heartbeatIntervalMs);
                    lifecycleHooks.beforeHeartbeatCheck(context.generation);
                    if (!context.isActive() || !isCurrentDaemon(context)) {
                        break;
                    }
                    if (!context.process.isAlive()) {
                        handleDaemonDeath(context, null);
                        break;
                    }

                    HeartbeatObservation observation =
                            context.captureHeartbeatObservation(timeSource);
                    int activeRequests = observation.activeRequestCount;
                    HeartbeatDecision decision = heartbeatProbeState.evaluate(observation);
                    if (decision == HeartbeatDecision.DECLARE_DEAD) {
                        String probeDetail = activeRequests <= 0
                                ? " after heartbeat probe" : " with active request";
                        LOG.warn("[DaemonBridge] Daemon unresponsive" + probeDetail
                                + " (activeRequests=" + activeRequests
                                + ", generation=" + context.generation + "), treating as dead");
                        DeathHandlingResult result = handleDaemonDeath(context, observation);
                        if (shouldContinueHeartbeatAfterDeath(result)) {
                            continue;
                        }
                        break;
                    }
                    if (decision == HeartbeatDecision.WAIT_FOR_PROBE) {
                        continue;
                    }
                    if (decision == HeartbeatDecision.SEND_PROBE) {
                        LOG.info("[DaemonBridge] Daemon heartbeat is stale; sending a resume-safe probe"
                                + " before restart (activeRequests=" + activeRequests
                                + ", generation=" + context.generation + ")");
                    }

                    // Send the regular heartbeat, or the one bounded liveness probe.
                    JsonObject hb = new JsonObject();
                    hb.addProperty("id", "hb-" + timeSource.currentTimeMillis());
                    hb.addProperty("method", "heartbeat");
                    synchronized (context.stdin) {
                        if (!isCurrentDaemon(context) || !context.isActive()) {
                            break;
                        }
                        context.stdin.write(hb.toString());
                        context.stdin.newLine();
                        context.stdin.flush();
                    }
                } catch (InterruptedException e) {
                    break;
                } catch (IOException e) {
                    LOG.warn("[DaemonBridge] Heartbeat failed: " + e.getMessage());
                    handleDaemonDeath(context, null);
                    break;
                }
            }
        }, "DaemonBridge-Heartbeat");
        context.heartbeatThread.setDaemon(true);
        context.heartbeatThread.start();
    }

    // =========================================================================
    // Output Parsing
    // =========================================================================

    private void handleDaemonOutput(String jsonLine, DaemonGenerationContext context) {
        synchronized (context) {
            if (!isCurrentDaemon(context) || !context.isActive()) {
                return;
            }
            handleActiveDaemonOutput(jsonLine, context);
        }
    }

    private void handleActiveDaemonOutput(String jsonLine, DaemonGenerationContext context) {
        context.heartbeatTimestamps.markActivity(timeSource);
        // Skip non-JSON lines (SDK debug output, permission logs, etc.)
        String trimmed = jsonLine.trim();
        if (trimmed.isEmpty() || trimmed.charAt(0) != '{') {
            LOG.debug("[DaemonBridge] Non-JSON output: " + trimmed);
            return;
        }

        try {
            JsonElement element = JsonParser.parseString(trimmed);
            if (!element.isJsonObject()) { return; }
            JsonObject obj = element.getAsJsonObject();

            // --- Daemon lifecycle events ---
            if (obj.has("type")) {
                String type = obj.get("type").getAsString();

                if ("daemon".equals(type)) {
                    handleDaemonEvent(obj, context);
                    return;
                }

                if ("heartbeat".equals(type)) {
                    // Heartbeat response — daemon is alive
                    context.markHeartbeat(timeSource);
                    return;
                }

                if ("status".equals(type)) {
                    // Status response
                    return;
                }
            }

            // --- Request-tagged output ---
            if (!obj.has("id")) { return; }
            String id = obj.get("id").getAsString();

            // Skip heartbeat responses
            if (id.startsWith("hb-")) { return; }

            RequestHandler handler = context.getRequestHandler(id);
            if (handler == null) {
                LOG.debug("[DaemonBridge] No handler for request " + id);
                return;
            }

            // Command completion
            if (obj.has("done")) {
                boolean success = obj.has("success") && obj.get("success").getAsBoolean();
                if (!success && obj.has("error")) {
                    handler.onError(obj.get("error").getAsString());
                }
                handler.onComplete(success);
                context.removeRequest(id);
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
            LOG.error("[DaemonBridge] Failed to parse daemon output: " + jsonLine, e);
        }
    }

    private void handleDaemonEvent(JsonObject obj, DaemonGenerationContext context) {
        String event = obj.has("event") ? obj.get("event").getAsString() : "unknown";
        LOG.info("[DaemonBridge] Daemon event: " + event);

        switch (event) {
            case "ready":
                boolean preloaded = obj.has("sdkPreloaded")
                        && obj.get("sdkPreloaded").getAsBoolean();
                if (context.signalReady(preloaded) && lifecycleListener != null) {
                    lifecycleListener.onDaemonReady();
                }
                break;

            case "startup_failed": {
                String startupError = obj.has("error") ? obj.get("error").getAsString() : "unknown";
                LOG.warn("[DaemonBridge] Daemon reported startup_failed: " + startupError);
                break;
            }

            case "sdk_loaded":
                context.markSdkPreloaded();
                LOG.info("[DaemonBridge] SDK pre-loaded successfully");
                break;

            case "sdk_load_error":
                String error = obj.has("error") ? obj.get("error").getAsString() : "unknown";
                LOG.warn("[DaemonBridge] SDK pre-load failed: " + error);
                break;

            case "shutdown":
                LOG.info("[DaemonBridge] Daemon shutting down");
                break;

            case "title_log": {
                String titleLevel = obj.has("level") ? obj.get("level").getAsString() : "info";
                String titleMsg = obj.has("message") ? obj.get("message").getAsString() : "";
                if ("error".equals(titleLevel) || "warn".equals(titleLevel)) {
                    LOG.warn("[TitleService] " + titleMsg);
                } else {
                    LOG.info("[TitleService] " + titleMsg);
                }
                break;
            }

            case "title_generated": {
                LOG.info("[DaemonBridge] AI title generated: sessionId="
                        + (obj.has("sessionId") ? obj.get("sessionId").getAsString() : "?")
                        + ", title=" + (obj.has("title") ? obj.get("title").getAsString() : "?"));
                for (DaemonEventListener listener : eventListeners) {
                    try {
                        listener.onDaemonEvent(event, obj);
                    } catch (Exception ex) {
                        LOG.warn("[DaemonBridge] Listener threw while handling " + event, ex);
                    }
                }
                break;
            }

            case "session_updated": {
                // Extract and validate sessionId
                String sessionId = obj.has("sessionId") ? obj.get("sessionId").getAsString() : null;
                if (sessionId == null || sessionId.isEmpty()) {
                    LOG.warn("[DaemonBridge] session_updated event missing sessionId, skipping");
                    break;
                }

                LOG.info("[DaemonBridge] Session updated: sessionId=" + sessionId);

                // Iterate through registered eventListeners and dispatch
                for (DaemonEventListener listener : eventListeners) {
                    try {
                        listener.onDaemonEvent(event, obj);
                    } catch (Exception ex) {
                        LOG.warn("[DaemonBridge] Listener threw while handling " + event, ex);
                    }
                }
                break;
            }

            case "task_event": {
                // Async subagent lifecycle event (task_notification for a
                // background Agent invoked with run_in_background:true). Emitted
                // by the ai-bridge perpetual reader's inter-turn branch; dispatch
                // to listeners exactly like session_updated so ClaudeChatWindow
                // can forward it to the frontend.
                //
                // Dual delivery path (intentional defense-in-depth): task_* may
                // ALSO reach the frontend in-turn via the [MESSAGE] stream
                // (ClaudeMessageHandler.handleSystemMessage -> notifyTaskEvent),
                // depending on whether the SDK drains task_notification before or
                // after the turn's result. Both paths converge on
                // SessionCallbackAdapter.onTaskEvent -> window.onTaskEvent, where
                // registerCallbacks.ts dedups by tool_use_id + observable fields,
                // so a duplicate delivery is a no-op rather than a double update.
                // Do NOT delete either path without first confirming at runtime
                // which is active (enable LOG.debug below + ai-bridge's
                // [PERPETUAL_READER] Inter-turn log to verify).
                String taskSessionId = obj.has("sessionId") && obj.get("sessionId").isJsonPrimitive()
                        ? obj.get("sessionId").getAsString() : "?";
                LOG.debug("[DaemonBridge] task_event received: sessionId=" + taskSessionId);
                for (DaemonEventListener listener : eventListeners) {
                    try {
                        listener.onDaemonEvent(event, obj);
                    } catch (Exception ex) {
                        LOG.warn("[DaemonBridge] Listener threw while handling " + event, ex);
                    }
                }
                break;
            }

            default:
                LOG.debug("[DaemonBridge] Unhandled daemon event: " + event);
        }
    }

    // =========================================================================
    // Daemon Death & Auto-Restart
    // =========================================================================

    private DeathHandlingResult handleDaemonDeath(
            DaemonGenerationContext context,
            HeartbeatObservation timeoutObservation
    ) {
        List<RequestHandler> failedHandlers;
        long claimedStopEpoch;
        synchronized (context) {
            if (timeoutObservation != null
                    && !context.matchesTimeoutObservation(timeoutObservation)) {
                LOG.info("[DaemonBridge] Cancelling stale heartbeat timeout for generation="
                        + context.generation + " because daemon progress advanced");
                return DeathHandlingResult.CANCELLED;
            }
            synchronized (startLock) {
                if (!isCurrentDaemon(context) || !context.isActive() || !desiredRunning
                        || restartInProgress) {
                    LOG.debug("[DaemonBridge] Ignoring stale death signal for generation="
                            + context.generation);
                    return DeathHandlingResult.STALE_GENERATION;
                }
                restartInProgress = true;
                claimedStopEpoch = stopEpoch;
                context.claimDeath();
            }
            failedHandlers = context.drainRequests();
        }

        LOG.warn("[DaemonBridge] Daemon process died, generation=" + context.generation);

        // Kill only the process whose generation was atomically claimed.
        if (context.process.isAlive()) {
            LOG.info("[DaemonBridge] Forcefully killing unresponsive daemon process (PID: "
                    + context.process.pid() + ", generation=" + context.generation + ")");
            context.process.destroyForcibly();
            try {
                context.process.waitFor(2, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        // The old generation is already detached, so callbacks cannot remove B's requests.
        for (RequestHandler handler : failedHandlers) {
            try {
                handler.onError("Daemon process died unexpectedly");
            } catch (RuntimeException e) {
                LOG.warn("[DaemonBridge] Request callback failed during daemon cleanup", e);
            }
        }

        if (lifecycleListener != null) {
            try {
                lifecycleListener.onDaemonDied();
            } catch (RuntimeException e) {
                LOG.warn("[DaemonBridge] Lifecycle listener failed during daemon cleanup", e);
            }
        }

        // Stability intentionally includes suspended time on every platform.
        long uptime = elapsedWallMillis(
                timeSource.currentTimeMillis(), context.startedAtWallTimeMs);
        if (uptime > RESTART_WINDOW_MS) {
            restartAttempts.set(0);
        }

        Thread oldHeartbeat = context.heartbeatThread;
        if (oldHeartbeat != null && oldHeartbeat != Thread.currentThread()) {
            oldHeartbeat.interrupt();
        }

        if (!context.isStartupPublished()) {
            synchronized (startLock) {
                restartInProgress = false;
                StartAttempt startAttempt = activeStartAttempt;
                if (startAttempt != null && startAttempt.context == context) {
                    activeStartAttempt = null;
                    if (stopEpoch == startAttempt.stopEpoch) {
                        desiredRunning = false;
                    }
                    startAttempt.complete(false);
                }
            }
            LOG.info("[DaemonBridge] Initial daemon exited before ready; "
                    + "background restart is disabled until the owner calls start() again. "
                    + context.formatRecentStderrTail());
            return DeathHandlingResult.CLAIMED;
        }

        int attempts = restartAttempts.incrementAndGet();
        lifecycleHooks.beforeAutoRestartCheck(context.generation);
        StartAttempt restartAttempt = null;
        synchronized (startLock) {
            restartInProgress = false;
            boolean stillDesired = desiredRunning
                    && stopEpoch == claimedStopEpoch
                    && daemonContext == context
                    && !context.isStopped();
            if (shouldAutoRestart(
                    desiredRunning,
                    stopEpoch,
                    claimedStopEpoch,
                    daemonContext,
                    context,
                    attempts)) {
                LOG.info("[DaemonBridge] Attempting restart (" + attempts + "/"
                        + MAX_RESTART_ATTEMPTS + ", last uptime=" + uptime + "ms)");
                restartAttempt = reserveStartAttemptLocked();
            } else if (!stillDesired) {
                LOG.info("[DaemonBridge] Automatic restart cancelled by newer lifecycle intent");
            } else {
                LOG.error("[DaemonBridge] Max restart attempts reached (" + attempts
                        + " within " + RESTART_WINDOW_MS
                        + "ms window). Daemon will not be restarted.");
            }
        }
        lifecycleHooks.afterAutoRestartCheck(context.generation);
        if (restartAttempt != null) {
            executeStartAttempt(restartAttempt);
        }
        return DeathHandlingResult.CLAIMED;
    }

    // =========================================================================
    // Setters
    // =========================================================================

    public void setLifecycleListener(DaemonLifecycleListener listener) {
        this.lifecycleListener = listener;
    }

    /**
     * Register a listener for custom daemon events (e.g., title_generated).
     * Multiple listeners may coexist; each is invoked on every matching event.
     * Callers MUST pair this with {@link #removeEventListener} on disposal to
     * avoid memory leaks.
     */
    public void addEventListener(DaemonEventListener listener) {
        if (listener == null) { return; }
        eventListeners.add(listener);
    }

    /**
     * Remove a previously registered listener. No-op if not registered.
     */
    public void removeEventListener(DaemonEventListener listener) {
        if (listener == null) { return; }
        eventListeners.remove(listener);
    }

    public boolean isSdkPreloaded() {
        DaemonGenerationContext context = daemonContext;
        return context != null && context.sdkPreloaded.get();
    }

    private void logDaemonStartupFailure(
            DaemonGenerationContext context,
            String phase
    ) {
        int exitCode = Integer.MIN_VALUE;
        Process process = context != null ? context.process : null;
        if (process != null) {
            try {
                if (!process.isAlive()) {
                    exitCode = process.exitValue();
                }
            } catch (IllegalThreadStateException stillRunning) {
                exitCode = Integer.MIN_VALUE;
            }
        }
        String exitLabel = exitCode == Integer.MIN_VALUE ? "unknown" : String.valueOf(exitCode);
        LOG.warn("[DaemonBridge] Daemon exited before signaling ready"
                + " (phase=" + phase
                + ", exitCode=" + exitLabel
                + ", " + (context != null
                        ? context.formatRecentStderrTail() : "stderr=(unavailable)") + ")");
    }

    static boolean shouldTreatAsUnresponsive(long heartbeatAgeMs, long activityAgeMs, int activeRequestCount) {
        if (activeRequestCount <= 0) {
            return heartbeatAgeMs > HEARTBEAT_TIMEOUT_MS;
        }
        long livenessAgeMs = Math.min(heartbeatAgeMs, activityAgeMs);
        return livenessAgeMs > ACTIVE_REQUEST_HEARTBEAT_TIMEOUT_MS;
    }

    static boolean shouldRecordStderrLine(
            DaemonGenerationContext currentContext,
            DaemonGenerationContext sourceContext
    ) {
        return sourceContext != null
                && currentContext == sourceContext
                && sourceContext.isActive();
    }

    static boolean shouldAutoRestart(
            boolean desiredRunning,
            long currentStopEpoch,
            long claimedStopEpoch,
            DaemonGenerationContext currentContext,
            DaemonGenerationContext claimedContext,
            int attempts
    ) {
        return desiredRunning
                && currentStopEpoch == claimedStopEpoch
                && currentContext == claimedContext
                && !claimedContext.isStopped()
                && attempts <= MAX_RESTART_ATTEMPTS;
    }

    enum HeartbeatDecision {
        HEALTHY,
        SEND_PROBE,
        WAIT_FOR_PROBE,
        DECLARE_DEAD
    }

    enum DeathHandlingResult {
        CLAIMED,
        CANCELLED,
        STALE_GENERATION
    }

    static boolean shouldContinueHeartbeatAfterDeath(DeathHandlingResult result) {
        return result == DeathHandlingResult.CANCELLED;
    }

    /**
     * Applies probe-first recovery only to idle daemons. Active requests keep
     * the established timeout semantics until request-level resume progress can
     * be identified independently from daemon heartbeat traffic.
     */
    static final class IdleHeartbeatProbeState {
        private long lastCheckWallTimeMs = -1;
        private long probeStartedAtNanos;
        private long probeHeartbeatVersion;
        private boolean probeActive;

        synchronized HeartbeatDecision evaluate(HeartbeatObservation observation) {
            long nowWallTimeMs = observation.nowWallTimeMs;
            long nowNanos = observation.nowNanos;
            int activeRequestCount = observation.activeRequestCount;
            boolean schedulerDiscontinuity = lastCheckWallTimeMs >= 0
                    && (nowWallTimeMs < lastCheckWallTimeMs
                    || nowWallTimeMs - lastCheckWallTimeMs > HEARTBEAT_SCHEDULER_GAP_MS);
            lastCheckWallTimeMs = nowWallTimeMs;

            // Keep the pre-existing active-request behavior. A heartbeat probe
            // alone cannot prove that a suspended SDK/network operation resumed.
            if (activeRequestCount > 0) {
                probeActive = false;
                return shouldTreatAsUnresponsive(
                        observation.heartbeatWallAgeMs,
                        observation.activityWallAgeMs,
                        activeRequestCount)
                        ? HeartbeatDecision.DECLARE_DEAD : HeartbeatDecision.HEALTHY;
            }

            // On every platform a wall-clock scheduler gap arms an idle probe,
            // regardless of whether that platform's nanoTime advances in suspend.
            if (schedulerDiscontinuity) {
                startProbe(nowNanos, observation.heartbeatVersion);
                return HeartbeatDecision.SEND_PROBE;
            }

            if (probeActive) {
                if (observation.heartbeatVersion != probeHeartbeatVersion) {
                    probeActive = false;
                    return HeartbeatDecision.HEALTHY;
                }
                if (elapsedMillis(nowNanos, probeStartedAtNanos)
                        < HEARTBEAT_PROBE_TIMEOUT_MS) {
                    return HeartbeatDecision.WAIT_FOR_PROBE;
                }
                return HeartbeatDecision.DECLARE_DEAD;
            }

            if (!shouldTreatAsUnresponsive(
                    observation.heartbeatMonotonicAgeMs,
                    observation.activityMonotonicAgeMs,
                    0)) {
                return HeartbeatDecision.HEALTHY;
            }

            startProbe(nowNanos, observation.heartbeatVersion);
            return HeartbeatDecision.SEND_PROBE;
        }

        synchronized void reset(long nowWallTimeMs) {
            lastCheckWallTimeMs = nowWallTimeMs;
            probeActive = false;
        }

        private void startProbe(long nowNanos, long heartbeatVersion) {
            probeStartedAtNanos = nowNanos;
            probeHeartbeatVersion = heartbeatVersion;
            probeActive = true;
        }
    }

    /** Stores both clocks so liveness policy is deterministic across suspend semantics. */
    static final class HeartbeatTimestamps {
        private long lastHeartbeatWallTimeMs;
        private long lastHeartbeatNanos;
        private long lastActivityWallTimeMs;
        private long lastActivityNanos;
        private long heartbeatVersion;
        private long activityVersion;

        HeartbeatTimestamps(long wallTimeMs, long nanos) {
            lastHeartbeatWallTimeMs = wallTimeMs;
            lastHeartbeatNanos = nanos;
            lastActivityWallTimeMs = wallTimeMs;
            lastActivityNanos = nanos;
        }

        synchronized void markHeartbeat(TimeSource timeSource) {
            long wallTimeMs = timeSource.currentTimeMillis();
            long nanos = timeSource.nanoTime();
            lastHeartbeatWallTimeMs = wallTimeMs;
            lastHeartbeatNanos = nanos;
            lastActivityWallTimeMs = wallTimeMs;
            lastActivityNanos = nanos;
            heartbeatVersion++;
            activityVersion++;
        }

        synchronized void markActivity(TimeSource timeSource) {
            lastActivityWallTimeMs = timeSource.currentTimeMillis();
            lastActivityNanos = timeSource.nanoTime();
            activityVersion++;
        }

        synchronized HeartbeatObservation snapshot(
                TimeSource timeSource,
                int activeRequestCount
        ) {
            long nowWallTimeMs = timeSource.currentTimeMillis();
            long nowNanos = timeSource.nanoTime();
            return new HeartbeatObservation(
                    nowWallTimeMs,
                    nowNanos,
                    elapsedWallMillis(nowWallTimeMs, lastHeartbeatWallTimeMs),
                    elapsedWallMillis(nowWallTimeMs, lastActivityWallTimeMs),
                    elapsedMillis(nowNanos, lastHeartbeatNanos),
                    elapsedMillis(nowNanos, lastActivityNanos),
                    heartbeatVersion,
                    activityVersion,
                    activeRequestCount);
        }

        synchronized boolean matches(HeartbeatObservation observation) {
            return heartbeatVersion == observation.heartbeatVersion
                    && activityVersion == observation.activityVersion;
        }
    }

    /** Immutable timeout observation revalidated immediately before claiming daemon death. */
    static final class HeartbeatObservation {
        private final long nowWallTimeMs;
        private final long nowNanos;
        private final long heartbeatWallAgeMs;
        private final long activityWallAgeMs;
        private final long heartbeatMonotonicAgeMs;
        private final long activityMonotonicAgeMs;
        private final long heartbeatVersion;
        private final long activityVersion;
        private final int activeRequestCount;

        HeartbeatObservation(
                long nowWallTimeMs,
                long nowNanos,
                long heartbeatWallAgeMs,
                long activityWallAgeMs,
                long heartbeatMonotonicAgeMs,
                long activityMonotonicAgeMs,
                long heartbeatVersion,
                long activityVersion,
                int activeRequestCount
        ) {
            this.nowWallTimeMs = nowWallTimeMs;
            this.nowNanos = nowNanos;
            this.heartbeatWallAgeMs = heartbeatWallAgeMs;
            this.activityWallAgeMs = activityWallAgeMs;
            this.heartbeatMonotonicAgeMs = heartbeatMonotonicAgeMs;
            this.activityMonotonicAgeMs = activityMonotonicAgeMs;
            this.heartbeatVersion = heartbeatVersion;
            this.activityVersion = activityVersion;
            this.activeRequestCount = activeRequestCount;
        }
    }

    enum DaemonGenerationState {
        ACTIVE,
        DEATH_CLAIMED,
        STOPPED
    }

    /** Owns all mutable state that must never cross a daemon generation boundary. */
    static final class DaemonGenerationContext {
        private final Process process;
        private final BufferedWriter stdin;
        private final long generation;
        private final long startedAtWallTimeMs;
        private final CountDownLatch readyLatch = new CountDownLatch(1);
        private final AtomicBoolean sdkPreloaded = new AtomicBoolean(false);
        private final AtomicInteger activeRequestCount = new AtomicInteger(0);
        private final ConcurrentHashMap<String, PendingRequest> pendingRequests =
                new ConcurrentHashMap<>();
        private final Deque<String> recentStderrLines = new ArrayDeque<>();
        private final HeartbeatTimestamps heartbeatTimestamps;
        private volatile DaemonGenerationState state = DaemonGenerationState.ACTIVE;
        private volatile boolean startupPublished;
        private volatile Thread readerThread;
        private volatile Thread heartbeatThread;

        DaemonGenerationContext(
                Process process,
                BufferedWriter stdin,
                long generation,
                long startedWallTimeMs,
                long startedAtNanos
        ) {
            this.process = process;
            this.stdin = stdin;
            this.generation = generation;
            this.startedAtWallTimeMs = startedWallTimeMs;
            this.heartbeatTimestamps = new HeartbeatTimestamps(
                    startedWallTimeMs, startedAtNanos);
        }

        boolean isActive() {
            return state == DaemonGenerationState.ACTIVE;
        }

        boolean isStopped() {
            return state == DaemonGenerationState.STOPPED;
        }

        void publishStartup() {
            startupPublished = true;
        }

        boolean isStartupPublished() {
            return startupPublished;
        }

        synchronized void claimDeath() {
            if (state == DaemonGenerationState.ACTIVE) {
                state = DaemonGenerationState.DEATH_CLAIMED;
            }
        }

        void stop() {
            state = DaemonGenerationState.STOPPED;
        }

        synchronized boolean signalReady(boolean preloaded) {
            if (!isActive()) {
                return false;
            }
            sdkPreloaded.set(preloaded);
            readyLatch.countDown();
            return true;
        }

        synchronized boolean markSdkPreloaded() {
            if (!isActive()) {
                return false;
            }
            sdkPreloaded.set(true);
            return true;
        }

        long readySignalsRemaining() {
            return readyLatch.getCount();
        }

        boolean isSdkPreloaded() {
            return sdkPreloaded.get();
        }

        synchronized void appendStderrLine(String line) {
            if (line == null) { return; }
            recentStderrLines.addLast(line);
            while (recentStderrLines.size() > STDERR_RING_CAPACITY) {
                recentStderrLines.removeFirst();
            }
        }

        synchronized String formatRecentStderrTail() {
            if (recentStderrLines.isEmpty()) {
                return "stderr=(empty)";
            }
            return "stderrTail=" + String.join(" | ", recentStderrLines);
        }

        synchronized HeartbeatObservation captureHeartbeatObservation(TimeSource timeSource) {
            return heartbeatTimestamps.snapshot(timeSource, activeRequestCount.get());
        }

        synchronized void markHeartbeat(TimeSource timeSource) {
            if (isActive()) {
                heartbeatTimestamps.markHeartbeat(timeSource);
            }
        }

        synchronized boolean matchesTimeoutObservation(HeartbeatObservation observation) {
            return heartbeatTimestamps.matches(observation)
                    && activeRequestCount.get() == observation.activeRequestCount;
        }

        synchronized boolean registerRequest(
                String id,
                RequestHandler handler,
                boolean countsAsActiveRequest,
                TimeSource timeSource
        ) {
            if (!isActive()) {
                return false;
            }
            pendingRequests.put(id, new PendingRequest(handler, countsAsActiveRequest));
            if (countsAsActiveRequest) {
                activeRequestCount.incrementAndGet();
            }
            heartbeatTimestamps.markActivity(timeSource);
            return true;
        }

        synchronized RequestHandler getRequestHandler(String id) {
            PendingRequest request = pendingRequests.get(id);
            return request != null ? request.handler : null;
        }

        synchronized void removeRequest(String id) {
            PendingRequest removed = pendingRequests.remove(id);
            if (removed != null && removed.countsAsActiveRequest) {
                activeRequestCount.updateAndGet(current -> Math.max(0, current - 1));
            }
        }

        synchronized List<RequestHandler> drainRequests() {
            List<RequestHandler> handlers = new ArrayList<>();
            for (PendingRequest request : pendingRequests.values()) {
                handlers.add(request.handler);
            }
            pendingRequests.clear();
            activeRequestCount.set(0);
            return handlers;
        }
    }

    private static final class PendingRequest {
        private final RequestHandler handler;
        private final boolean countsAsActiveRequest;

        private PendingRequest(RequestHandler handler, boolean countsAsActiveRequest) {
            this.handler = handler;
            this.countsAsActiveRequest = countsAsActiveRequest;
        }
    }

    /** A cancellable owner for one process launch and ready wait. */
    private static final class StartAttempt {
        private final long id;
        private final long stopEpoch;
        private final CountDownLatch completion = new CountDownLatch(1);
        private final AtomicBoolean completed = new AtomicBoolean(false);
        private volatile boolean cancelled;
        private volatile boolean result;
        private volatile DaemonGenerationContext context;

        private StartAttempt(long id, long stopEpoch) {
            this.id = id;
            this.stopEpoch = stopEpoch;
        }

        private void cancel() {
            cancelled = true;
            complete(false);
        }

        private boolean isCancelled() {
            return cancelled;
        }

        private void complete(boolean success) {
            if (completed.compareAndSet(false, true)) {
                result = success;
                completion.countDown();
            }
        }

        private boolean awaitResult() {
            try {
                // Bound the wait: if the owner thread dies from an Error (e.g.
                // OOM) complete() is never called and concurrent start()
                // callers would block forever.
                return completion.await(DAEMON_START_TIMEOUT_MS * 2, TimeUnit.MILLISECONDS)
                        && result;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
    }

    @FunctionalInterface
    interface DaemonProcessLauncher {
        Process launch() throws IOException;
    }

    interface DaemonLifecycleHooks {
        DaemonLifecycleHooks NO_OP = new DaemonLifecycleHooks() { };

        default void beforeAutoRestartCheck(long generation) {
            // No-op in production.
        }

        default void afterAutoRestartCheck(long generation) {
            // No-op in production.
        }

        default void beforeHeartbeatCheck(long generation) {
            // No-op in production.
        }
    }

    interface TimeSource {
        long currentTimeMillis();
        long nanoTime();

        static TimeSource system() {
            return SystemTimeSource.INSTANCE;
        }
    }

    private enum SystemTimeSource implements TimeSource {
        INSTANCE;

        @Override
        public long currentTimeMillis() {
            return System.currentTimeMillis();
        }

        @Override
        public long nanoTime() {
            return System.nanoTime();
        }
    }

    private boolean isCurrentDaemon(DaemonGenerationContext context) {
        return daemonContext == context;
    }

    private static long elapsedMillis(long nowNanos, long startedAtNanos) {
        long elapsedNanos = nowNanos - startedAtNanos;
        return elapsedNanos <= 0 ? 0 : TimeUnit.NANOSECONDS.toMillis(elapsedNanos);
    }

    private static long elapsedWallMillis(long nowWallTimeMs, long startedWallTimeMs) {
        long elapsedMs = nowWallTimeMs - startedWallTimeMs;
        return Math.max(0, elapsedMs);
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

        /**
         * Called when the user manually aborts the request.
         * Default implementation delegates to {@link #onComplete(boolean) onComplete(false)}
         * so that aborts are treated as a graceful (unsuccessful) completion,
         * not an error.
         */
        default void onAbort() {
            onComplete(false);
        }
    }

    /**
     * Lifecycle listener for daemon events.
     */
    public interface DaemonLifecycleListener {
        void onDaemonReady();
        void onDaemonDied();
    }

    /**
     * Listener for custom daemon events (e.g., title_generated).
     */
    public interface DaemonEventListener {
        void onDaemonEvent(String event, JsonObject data);
    }

    /**
     * Internal handler that wraps callback + future for a pending request.
     */
    static class RequestHandler {
        final DaemonOutputCallback callback;
        final CompletableFuture<Boolean> future;

        RequestHandler(DaemonOutputCallback callback, CompletableFuture<Boolean> future) {
            this.callback = callback;
            this.future = future;
        }

        void onError(String error) {
            callback.onError(error);
            future.completeExceptionally(new RuntimeException(error));
        }

        /**
         * Handle user-initiated abort gracefully.
         * Unlike onError, this completes the future normally (with false) so callers
         * do not see an exception. The DaemonOutputCallback.onAbort() method lets
         * the downstream handler distinguish aborts from real errors.
         */
        void onAbort() {
            callback.onAbort();
            future.complete(false);
        }

        void onComplete(boolean success) {
            callback.onComplete(success);
            future.complete(success);
        }
    }
}

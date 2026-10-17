package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * Sends Codex requests through the long-running daemon (task 6.1).
 *
 * <p>One daemon generation carries many native turns: {@code codex.send}
 * occupies the daemon request until the native terminal, while structured
 * {@code codex_event} payloads arrive out of band through the coordinator's
 * daemon event listeners — never through this request's line stream.
 */
class CodexAppServerRequestExecutor {

    /**
     * Dedicated executor for calls that block for a turn's whole lifetime. A
     * native turn may run for hours, so waiting must never happen on
     * {@link CompletableFuture}'s common pool: the common pool has core-1
     * threads and is shared with interrupts and interaction replies, so
     * blocking it there starves the whole plugin (a 2-core machine deadlocks
     * on the very first send).
     */
    private static final ExecutorService TURN_WAIT_EXECUTOR = Executors.newCachedThreadPool(
            new ThreadFactory() {
                private final AtomicInteger counter = new AtomicInteger();

                @Override
                public Thread newThread(Runnable runnable) {
                    Thread thread = new Thread(runnable, "codex-daemon-rpc-" + this.counter.incrementAndGet());
                    thread.setDaemon(true);
                    return thread;
                }
            });

    /** Executor for callers that must not block a common-pool thread either. */
    public static Executor turnWaitExecutor() {
        return TURN_WAIT_EXECUTOR;
    }

    private final Logger log;
    private final Consumer<String> markerLineProcessor;

    /**
     * @param markerLineProcessor consumes operation-scoped marker lines
     *        ([MESSAGE_START], [CONTENT_DELTA], …) exactly like the legacy
     *        per-turn process output parser.
     */
    CodexAppServerRequestExecutor(Logger log, Consumer<String> markerLineProcessor) {
        this.log = log;
        this.markerLineProcessor = markerLineProcessor;
    }

    /**
     * Send a user message via {@code codex.send}. Returns when the daemon
     * command completes (native terminal or failure), and reports callbacks
     * through the given {@link MessageCallback}.
     */
    CompletableFuture<SDKResult> sendMessageViaDaemon(
            DaemonBridge daemon,
            JsonObject sendParams,
            Consumer<String> outputLineConsumer
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            AtomicBoolean hadSendError = new AtomicBoolean(false);
            AtomicReference<String> lastNodeError = new AtomicReference<>(null);
            AtomicBoolean wasAborted = new AtomicBoolean(false);
            try {
                CodexAppServerRequestExecutor.this.log.info("[CodexDaemonExecutor] Sending via daemon: codex.send");
                CompletableFuture<Boolean> cmdFuture = daemon.sendCommand(
                        "codex.send",
                        sendParams,
                        new DaemonBridge.DaemonOutputCallback() {
                            @Override
                            public void onLine(String line) {
                                if (line.startsWith("[UNCAUGHT_ERROR]")
                                        || line.startsWith("[UNHANDLED_REJECTION]")
                                        || line.startsWith("[COMMAND_ERROR]")
                                        || line.startsWith("[STARTUP_ERROR]")) {
                                    CodexAppServerRequestExecutor.this.log.warn("[Codex][Node ERROR] " + line);
                                    lastNodeError.set(line);
                                }
                                if (outputLineConsumer != null) {
                                    outputLineConsumer.accept(line);
                                }
                                if (markerLineProcessor != null) {
                                    CodexAppServerRequestExecutor.this.markerLineProcessor.accept(line);
                                }
                            }

                            @Override
                            public void onStderr(String text) {
                                CodexAppServerRequestExecutor.this.log.debug("[CodexDaemonBridge:stderr] " + text);
                            }

                            @Override
                            public void onError(String error) {
                                if (!hadSendError.get()) {
                                    result.success = false;
                                    result.error = error;
                                    hadSendError.set(true);
                                }
                            }

                            @Override
                            public void onAbort() {
                                wasAborted.set(true);
                            }

                            @Override
                            public void onComplete(boolean success) {
                            }
                        }
                );

                Boolean success = awaitWithLiveness(cmdFuture, daemon);
                result.finalResult = "";
                result.messageCount = result.messages.size();
                if (wasAborted.get()) {
                    result.success = false;
                    result.error = "User interrupted";
                    return result;
                }
                if (!hadSendError.get()) {
                    result.success = Boolean.TRUE.equals(success);
                    if (!result.success && !wasAborted.get()) {
                        String errorMsg = "codex.send failed";
                        String nodeErr = lastNodeError.get();
                        if (nodeErr != null) {
                            errorMsg += " | " + nodeErr;
                        }
                        result.error = errorMsg;
                    }
                } else if (wasAborted.get()) {
                    result.success = false;
                    result.error = "User interrupted";
                }
                return result;
            } catch (Exception e) {
                if (wasAborted.get()) {
                    result.success = false;
                    result.error = "User interrupted";
                    return result;
                }
                if (!hadSendError.get()) {
                    result.success = false;
                    result.error = "Daemon request failed: " + e.getMessage();
                }
                return result;
            }
        }, TURN_WAIT_EXECUTOR);
    }

    /**
     * Send a request without an additional marker consumer.
     *
     * @param daemon daemon bridge
     * @param sendParams request parameters
     * @return daemon result
     */
    CompletableFuture<SDKResult> sendMessageViaDaemon(
            DaemonBridge daemon,
            JsonObject sendParams
    ) {
        return sendMessageViaDaemon(daemon, sendParams, null);
    }

    private Boolean awaitWithLiveness(CompletableFuture<Boolean> future, DaemonBridge daemon)
            throws Exception {
        while (true) {
            try {
                return future.get(30, TimeUnit.SECONDS);
            } catch (TimeoutException timeout) {
                if (!daemon.isAlive()) {
                    throw new RuntimeException("Daemon not alive while waiting for codex.send", timeout);
                }
                CodexAppServerRequestExecutor.this.log.debug("[CodexDaemonExecutor] codex.send still running, waiting…");
            }
        }
    }

    /**
     * Fire a control command (respondInteraction / abortTurn / updateSettings
     * / releaseThread / resetRuntime) and wait briefly for its ack. These are
     * queued by the daemon independently of a running codex.send.
     */
    JsonObject sendControlCommand(DaemonBridge daemon, String method, JsonObject params, long timeoutMs) {
        try {
            CompletableFuture<Boolean> future = daemon.sendCommand(method, params,
                    new DaemonBridge.DaemonOutputCallback() {
                        @Override
                        public void onLine(String line) {
                            CodexAppServerRequestExecutor.this.log.debug("[CodexDaemonExecutor] control line: " + line);
                        }

                        @Override
                        public void onStderr(String text) {
                            CodexAppServerRequestExecutor.this.log.debug("[CodexDaemonExecutor] control stderr: " + text);
                        }

                        @Override
                        public void onError(String error) {
                            CodexAppServerRequestExecutor.this.log.warn("[CodexDaemonExecutor] control error: " + error);
                        }

                        @Override
                        public void onComplete(boolean success) {
                        }
                    });
            Boolean success = future.get(timeoutMs, TimeUnit.MILLISECONDS);
            if (!Boolean.TRUE.equals(success)) {
                JsonObject error = new JsonObject();
                error.addProperty("error", method + " was rejected by the daemon");
                return error;
            }
            return new JsonObject();
        } catch (Exception e) {
            CodexAppServerRequestExecutor.this.log.warn("[CodexDaemonExecutor] control command " + method + " failed: " + e.getMessage());
            JsonObject error = new JsonObject();
            error.addProperty("error", e.getMessage());
            return error;
        }
    }

    /**
     * Send an independent read-only command and retain its structured result.
     *
     * @param daemon live daemon bridge
     * @param method read-only Codex command
     * @param params command parameters
     * @param timeoutMs maximum wait in milliseconds
     * @return daemon result payload or an object containing {@code error}
     */
    JsonObject sendReadOnlyCommand(
            DaemonBridge daemon,
            String method,
            JsonObject params,
            long timeoutMs
    ) {
        AtomicReference<JsonObject> responseRef = new AtomicReference<>();
        try {
            CompletableFuture<Boolean> future = daemon.sendCommand(method, params,
                    new DaemonBridge.DaemonOutputCallback() {
                        @Override
                        public void onLine(String line) {
                            CodexAppServerRequestExecutor.this.log.debug("[CodexDaemonExecutor] read-only line: " + line);
                        }

                        @Override
                        public void onStderr(String text) {
                            CodexAppServerRequestExecutor.this.log.debug("[CodexDaemonExecutor] read-only stderr: " + text);
                        }

                        @Override
                        public void onError(String error) {
                            CodexAppServerRequestExecutor.this.log.warn("[CodexDaemonExecutor] read-only error: " + error);
                        }

                        @Override
                        public void onResult(JsonObject response) {
                            responseRef.set(response == null ? null : response.deepCopy());
                        }

                        @Override
                        public void onComplete(boolean success) {
                        }
                    });
            Boolean success = future.get(timeoutMs, TimeUnit.MILLISECONDS);
            JsonObject response = responseRef.get();
            if (response != null && response.has("result") && response.get("result").isJsonObject()) {
                return response.getAsJsonObject("result").deepCopy();
            }
            if (response != null && response.has("error")) {
                return response.deepCopy();
            }
            JsonObject fallback = new JsonObject();
            fallback.addProperty("success", Boolean.TRUE.equals(success));
            if (!Boolean.TRUE.equals(success)) {
                fallback.addProperty("error", method + " failed");
            }
            return fallback;
        } catch (Exception e) {
            CodexAppServerRequestExecutor.this.log.warn("[CodexDaemonExecutor] read-only command " + method + " failed: " + e.getMessage());
            JsonObject error = new JsonObject();
            // TimeoutException carries a null message; a JsonNull here would
            // blow up consumers calling getAsString() on the error field.
            error.addProperty("error", e.getMessage() != null ? e.getMessage() : e.toString());
            return error;
        }
    }

    /**
     * Send a Codex FIFO operation without imposing a short control timeout.
     *
     * @param daemon live daemon bridge
     * @param method daemon operation method
     * @param params operation parameters
     * @return future completed at the daemon terminal
     */
    CompletableFuture<JsonObject> sendLongOperationCommand(
            DaemonBridge daemon,
            String method,
            JsonObject params
    ) {
        return this.sendLongOperationCommand(daemon, method, params, null);
    }

    /** Keep native operation markers on the same display path as normal sends. */
    CompletableFuture<JsonObject> sendLongOperationCommand(
            DaemonBridge daemon, String method, JsonObject params, Consumer<String> outputLineConsumer
    ) {
        AtomicReference<String> nativeError = new AtomicReference<>();
        AtomicReference<JsonObject> nativeResult = new AtomicReference<>();
        return daemon.sendCommand(method, params, new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) {
                if (outputLineConsumer != null) {
                    outputLineConsumer.accept(line);
                }
            }

            @Override
            public void onStderr(String text) {
                CodexAppServerRequestExecutor.this.log.debug("[CodexDaemonExecutor] long operation stderr: " + text);
            }

            @Override
            public void onError(String error) {
                nativeError.compareAndSet(null, error);
                CodexAppServerRequestExecutor.this.log.warn("[CodexDaemonExecutor] long operation error: " + error);
            }

            /** Retains the native terminal outcome independently of transport success. */
            @Override
            public void onResult(JsonObject response) {
                if (response != null && response.has("result") && response.get("result").isJsonObject()) {
                    nativeResult.set(response.getAsJsonObject("result").deepCopy());
                }
            }

            @Override
            public void onComplete(boolean success) {
            }
        }).thenApply(success -> {
            JsonObject result = new JsonObject();
            result.addProperty("success", Boolean.TRUE.equals(success));
            JsonObject nativeOutcome = nativeResult.get();
            if (nativeOutcome != null && nativeOutcome.has("outcome")) {
                result.add("outcome", nativeOutcome.get("outcome").deepCopy());
            }
            if (!Boolean.TRUE.equals(success)) {
                result.addProperty("error", nativeError.get() == null ? method + " failed" : nativeError.get());
            }
            return result;
        });
    }

    /** Builds the codex.send params payload for the daemon (task 6.3 identity). */
    static JsonObject buildSendParams(
            String channelId,
            String sessionEpoch,
            String clientMessageId,
            String message,
            String threadId,
            String cwd,
            String permissionMode,
            String model,
            String reasoningEffort,
            String serviceTier,
            JsonArray attachments
    ) {
        return buildSendParams(
                channelId, sessionEpoch, clientMessageId, message, threadId, cwd,
                permissionMode, model, reasoningEffort, serviceTier,
                attachments, null);
    }

    /** Builds send params with the filtered native Codex settings snapshot. */
    static JsonObject buildSendParams(
            String channelId,
            String sessionEpoch,
            String clientMessageId,
            String message,
            String threadId,
            String cwd,
            String permissionMode,
            String model,
            String reasoningEffort,
            String serviceTier,
            JsonArray attachments,
            JsonObject nativeSettings
    ) {
        JsonObject params = new JsonObject();
        params.addProperty("channelId", channelId);
        params.addProperty("sessionEpoch", sessionEpoch);
        params.addProperty("clientMessageId", clientMessageId);
        params.addProperty("message", message);
        params.addProperty("threadId", threadId != null ? threadId : "");
        params.addProperty("cwd", cwd != null ? cwd : "");
        params.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
        params.addProperty("model", model != null ? model : "");
        params.addProperty("reasoningEffort", reasoningEffort != null ? reasoningEffort : "medium");
        params.addProperty("serviceTier", serviceTier != null ? serviceTier : "");
        // Managed credentials never travel per request: the daemon resolves them
        // from its sanitized environment (config.toml env_key). See
        // codex-native-runtime-config.js.
        if (attachments != null && attachments.size() > 0) {
            params.add("attachments", attachments);
        }
        if (nativeSettings != null) {
            copyNativeSetting(nativeSettings, params, "collaborationMode");
            copyNativeSetting(nativeSettings, params, "approvalPreset");
            copyNativeSetting(nativeSettings, params, "sandboxSelection");
            if (nativeSettings.has("cwdExplicit")) {
                params.add("cwdExplicit", nativeSettings.get("cwdExplicit").deepCopy());
            }
            if (nativeSettings.has("skills") && nativeSettings.get("skills").isJsonArray()) {
                params.add("skills", nativeSettings.getAsJsonArray("skills").deepCopy());
            }
        }
        return params;
    }

    private static void copyNativeSetting(JsonObject source, JsonObject target, String key) {
        if (source.has(key) && source.get(key).isJsonPrimitive()) {
            String value = source.get(key).getAsString();
            if (value != null && !value.trim().isEmpty()) {
                target.addProperty(key, value.trim());
            }
        }
    }
}

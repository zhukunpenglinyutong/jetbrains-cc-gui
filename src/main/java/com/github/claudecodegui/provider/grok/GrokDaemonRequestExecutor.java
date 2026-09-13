package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Sends Grok requests through the long-running daemon (grok.* NDJSON commands).
 */
class GrokDaemonRequestExecutor {

    private final Logger log;
    private final GrokSDKBridge bridge; // for processOutputLine + payload builder

    GrokDaemonRequestExecutor(Logger log, GrokSDKBridge bridge) {
        this.log = log;
        this.bridge = bridge;
    }

    CompletableFuture<SDKResult> sendMessageViaDaemon(
            DaemonBridge daemon,
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            AtomicBoolean hadSendError = new AtomicBoolean(false);
            AtomicReference<String> lastNodeError = new AtomicReference<>(null);
            AtomicBoolean wasAborted = new AtomicBoolean(false);
            long startTime = System.currentTimeMillis();

            try {
                JsonObject params = bridge.buildStdinPayloadForDaemon(
                        message,
                        sessionId,
                        runtimeSessionEpoch,
                        cwd,
                        attachments,
                        permissionMode,
                        model,
                        openedFiles,
                        agentPrompt,
                        streaming,
                        disableThinking,
                        reasoningEffort
                );

                params.add("env", new JsonObject()); // daemon will merge base env

                log.info("[GrokDaemonExecutor] Sending via daemon: grok.send");

                CompletableFuture<Boolean> cmdFuture = daemon.sendCommand(
                        "grok.send",
                        params,
                        new DaemonBridge.DaemonOutputCallback() {
                            @Override
                            public void onLine(String line) {
                                if (line.startsWith("[UNCAUGHT_ERROR]")
                                        || line.startsWith("[UNHANDLED_REJECTION]")
                                        || line.startsWith("[COMMAND_ERROR]")
                                        || line.startsWith("[STARTUP_ERROR]")
                                        || line.startsWith("[ERROR]")) {
                                    log.warn("[Grok Node ERROR] " + line);
                                    lastNodeError.set(line);
                                }
                                // Reuse GrokSDKBridge processing (Claude-shaped tags)
                                bridge.processOutputLine(
                                        line,
                                        callback,
                                        result,
                                        assistantContent,
                                        hadSendError,
                                        lastNodeError
                                );
                            }

                            @Override
                            public void onStderr(String text) {
                                if (text != null && text.contains("[SEND_ERROR]")) {
                                    bridge.processOutputLine(
                                            text,
                                            callback,
                                            result,
                                            assistantContent,
                                            hadSendError,
                                            lastNodeError
                                    );
                                    return;
                                }
                                log.debug("[GrokDaemon:stderr] " + text);
                            }

                            @Override
                            public void onError(String error) {
                                if (!hadSendError.get()) {
                                    result.success = false;
                                    result.error = error;
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

                Boolean success;
                long waitStart = System.currentTimeMillis();
                long lastProgressLogAt = waitStart;
                while (true) {
                    try {
                        success = cmdFuture.get(30, TimeUnit.SECONDS);
                        break;
                    } catch (TimeoutException timeout) {
                        if (!daemon.isAlive()) {
                            throw new RuntimeException("Grok daemon not alive", timeout);
                        }
                        long now = System.currentTimeMillis();
                        if (now - lastProgressLogAt >= 60_000) {
                            long elapsedSec = (now - waitStart) / 1000;
                            log.info("[GrokDaemonExecutor] still running (" + elapsedSec + "s)...");
                            lastProgressLogAt = now;
                        }
                    }
                }

                result.finalResult = assistantContent.toString();
                result.messageCount = result.messages.size();

                if (!hadSendError.get()) {
                    result.success = success != null && success;
                    if (result.success) {
                        callback.onComplete(result);
                    } else if (wasAborted.get()) {
                        long elapsed = System.currentTimeMillis() - startTime;
                        log.info("[GrokDaemonExecutor] aborted by user (" + elapsed + "ms)");
                        result.error = "User interrupted";
                        callback.onComplete(result);
                    } else {
                        String errorMsg = "Grok daemon command failed";
                        String nodeErr = lastNodeError.get();
                        if (nodeErr != null) {
                            errorMsg += "\n\nDetails: " + nodeErr;
                        }
                        if (result.error == null) {
                            result.error = errorMsg;
                        }
                        callback.onError(result.error);
                    }
                } else {
                    callback.onError(result.error != null ? result.error : "Grok send error");
                }

                return result;
            } catch (Exception e) {
                if (!hadSendError.get()) {
                    result.success = false;
                    result.error = e.getMessage();
                    callback.onError(result.error);
                }
                return result;
            }
        });
    }
}

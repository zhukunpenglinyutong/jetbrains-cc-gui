package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Sends Codex requests through the long-running daemon.
 */
class CodexDaemonRequestExecutor {

    private final Logger log;
    private final CodexSDKBridge bridge;

    CodexDaemonRequestExecutor(Logger log, CodexSDKBridge bridge) {
        this.log = log;
        this.bridge = bridge;
    }

    CompletableFuture<SDKResult> sendMessageViaDaemon(
            DaemonBridge daemon,
            JsonObject params,
            MessageCallback callback,
            List<File> tempImageFiles
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            AtomicBoolean hadSendError = new AtomicBoolean(false);
            AtomicReference<String> lastNodeError = new AtomicReference<>(null);
            AtomicBoolean wasAborted = new AtomicBoolean(false);

            try {
                CompletableFuture<Boolean> cmdFuture = daemon.sendCommand(
                        "codex.send",
                        params,
                        new DaemonBridge.DaemonOutputCallback() {
                            @Override
                            public void onLine(String line) {
                                if (line.startsWith("[UNCAUGHT_ERROR]")
                                        || line.startsWith("[UNHANDLED_REJECTION]")
                                        || line.startsWith("[COMMAND_ERROR]")) {
                                    log.warn("[CodexDaemon] " + line);
                                    lastNodeError.set(line);
                                }
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
                                if (text != null && text.startsWith("[SEND_ERROR]")) {
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
                                if (text != null && !text.isBlank()) {
                                    log.debug("[CodexDaemon:stderr] " + text);
                                }
                            }

                            @Override
                            public void onError(String error) {
                                if (!hadSendError.get()) {
                                    result.success = false;
                                    result.error = error;
                                }
                            }

                            @Override
                            public void onDaemonEvent(String event, JsonObject data) {
                                if ("queue_waiting".equals(event)) {
                                    int aheadCount = data.has("aheadCount") ? data.get("aheadCount").getAsInt() : 0;
                                    callback.onQueueDisplayStateChanged(
                                            ClaudeSession.SessionCallback.QueueDisplayState.QUEUED,
                                            aheadCount
                                    );
                                    return;
                                }
                                if ("queue_started".equals(event)) {
                                    callback.onQueueDisplayStateChanged(
                                            ClaudeSession.SessionCallback.QueueDisplayState.PROCESSING,
                                            0
                                    );
                                    return;
                                }
                                if ("queue_cleared".equals(event) && !wasAborted.get()) {
                                    callback.onQueueDisplayStateChanged(
                                            ClaudeSession.SessionCallback.QueueDisplayState.NONE,
                                            0
                                    );
                                }
                            }

                            @Override
                            public void onAbort() {
                                wasAborted.set(true);
                                callback.onQueueDisplayStateChanged(
                                        ClaudeSession.SessionCallback.QueueDisplayState.NONE,
                                        0
                                );
                            }

                            @Override
                            public void onComplete(boolean success) {
                            }
                        }
                );

                Boolean success;
                while (true) {
                    try {
                        success = cmdFuture.get(30, TimeUnit.SECONDS);
                        break;
                    } catch (TimeoutException timeout) {
                        if (!daemon.isAlive()) {
                            throw new RuntimeException("Codex daemon is not alive while waiting for response", timeout);
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
                        result.error = "User interrupted";
                        callback.onComplete(result);
                    } else {
                        String errorMsg = "Codex daemon command failed";
                        String nodeErr = lastNodeError.get();
                        if (nodeErr != null && !nodeErr.isEmpty()) {
                            errorMsg = errorMsg + " | Last error: " + nodeErr;
                        }
                        if (result.error == null) {
                            result.error = errorMsg;
                        }
                        callback.onError(result.error);
                    }
                }

                return result;
            } catch (Exception e) {
                if (wasAborted.get()) {
                    result.success = false;
                    result.error = "User interrupted";
                    callback.onComplete(result);
                    return result;
                }
                if (!hadSendError.get()) {
                    result.success = false;
                    result.error = "Codex daemon request failed: " + e.getMessage();
                    callback.onError(result.error);
                }
                return result;
            } finally {
                cleanupTempImages(tempImageFiles);
            }
        }).exceptionally(ex -> {
            SDKResult errorResult = new SDKResult();
            errorResult.success = false;
            errorResult.error = ex.getMessage();
            callback.onError(errorResult.error);
            return errorResult;
        });
    }

    private void cleanupTempImages(List<File> tempImageFiles) {
        if (tempImageFiles == null || tempImageFiles.isEmpty()) {
            return;
        }
        for (File file : tempImageFiles) {
            try {
                if (file.exists() && file.delete()) {
                    log.debug("[CodexDaemon] Cleaned up temp image: " + file.getName());
                }
            } catch (Exception e) {
                log.debug("[CodexDaemon] Failed to cleanup temp image: " + e.getMessage());
            }
        }
    }
}

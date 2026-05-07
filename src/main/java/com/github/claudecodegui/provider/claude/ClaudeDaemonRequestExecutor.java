package com.github.claudecodegui.provider.claude;

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

/**
 * Sends Claude requests through the long-running daemon.
 */
class ClaudeDaemonRequestExecutor {

    private final Logger log;
    private final ClaudeRequestParamsBuilder requestParamsBuilder;
    private final ClaudeStreamAdapter streamAdapter;
    private final ClaudeJsonOutputExtractor outputExtractor;

    ClaudeDaemonRequestExecutor(
            Logger log,
            ClaudeRequestParamsBuilder requestParamsBuilder,
            ClaudeStreamAdapter streamAdapter,
            ClaudeJsonOutputExtractor outputExtractor
    ) {
        this.log = log;
        this.requestParamsBuilder = requestParamsBuilder;
        this.streamAdapter = streamAdapter;
        this.outputExtractor = outputExtractor;
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
            Boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            boolean[] hadSendError = {false};
            String[] lastNodeError = {null};

            try {
                JsonObject params = requestParamsBuilder.buildSendParams(
                        message,
                        sessionId,
                        runtimeSessionEpoch,
                        cwd,
                        permissionMode,
                        model,
                        attachments,
                        openedFiles,
                        agentPrompt,
                        streaming,
                        disableThinking,
                        reasoningEffort
                );

                boolean hasAttachments = attachments != null && !attachments.isEmpty() && params.has("attachments");
                params.add("env", ClaudeBridgeUtils.buildDaemonEnv(cwd));

                String method = hasAttachments ? "claude.sendWithAttachments" : "claude.send";
                log.info("[DaemonExecutor] Sending via daemon: " + method);

                CompletableFuture<Boolean> cmdFuture = daemon.sendCommand(
                        method,
                        params,
                        new DaemonBridge.DaemonOutputCallback() {
                            @Override
                            public void onLine(String line) {
                                if (line.startsWith("[UNCAUGHT_ERROR]")
                                        || line.startsWith("[UNHANDLED_REJECTION]")
                                        || line.startsWith("[COMMAND_ERROR]")
                                        || line.startsWith("[STARTUP_ERROR]")
                                        || line.startsWith("[ERROR]")) {
                                    log.warn("[Node.js ERROR] " + line);
                                    lastNodeError[0] = line;
                                }
                                streamAdapter.processOutputLine(
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
                                    streamAdapter.processOutputLine(
                                            text,
                                            callback,
                                            result,
                                            assistantContent,
                                            hadSendError,
                                            lastNodeError
                                    );
                                    return;
                                }
                                log.debug("[DaemonBridge:stderr] " + text);
                            }

                            @Override
                            public void onError(String error) {
                                if (!hadSendError[0]) {
                                    result.success = false;
                                    result.error = error;
                                }
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
                            throw new RuntimeException("Daemon process is not alive while waiting for response", timeout);
                        }
                        long now = System.currentTimeMillis();
                        if (now - lastProgressLogAt >= 60_000) {
                            long elapsedSec = (now - waitStart) / 1000;
                            log.info("[DaemonExecutor] Daemon request still running (" + elapsedSec + "s), waiting...");
                            lastProgressLogAt = now;
                        }
                    }
                }

                result.finalResult = assistantContent.toString();
                result.messageCount = result.messages.size();

                if (!hadSendError[0]) {
                    result.success = success != null && success;
                    if (result.success) {
                        callback.onComplete(result);
                    } else {
                        String errorMsg = "Daemon command failed";
                        if (lastNodeError[0] != null) {
                            errorMsg += "\n\nDetails: " + lastNodeError[0];
                        }
                        if (result.error == null) {
                            result.error = errorMsg;
                        }
                        callback.onError(result.error);
                    }
                }

                return result;
            } catch (Exception e) {
                if (!hadSendError[0]) {
                    result.success = false;
                    result.error = "Daemon request failed: " + outputExtractor.extractErrorMessage(e);
                    callback.onError(result.error);
                }
                return result;
            }
        }).exceptionally(ex -> {
            SDKResult errorResult = new SDKResult();
            errorResult.success = false;
            errorResult.error = outputExtractor.extractErrorMessage(ex);
            callback.onError(errorResult.error);
            return errorResult;
        });
    }

}

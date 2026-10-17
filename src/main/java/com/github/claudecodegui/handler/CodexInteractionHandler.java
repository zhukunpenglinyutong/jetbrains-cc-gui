package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.Set;

/**
 * Routes typed native Codex interaction decisions and control actions.
 *
 * <p>Codex responses use the opaque interaction key issued by the Java
 * registry. The browser never chooses the native RPC id or method.</p>
 */
public class CodexInteractionHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(CodexInteractionHandler.class);
    private static final Gson GSON = new Gson();
    private static final String[] SUPPORTED_TYPES = {
            "codex_interaction_response",
            "codex_interaction_error",
            "codex_interaction_delivery_ack",
            "codex_runtime_frontend_ready",
            "codex_abort_turn",
            "codex_update_settings",
            "set_codex_collaboration_mode",
            "set_codex_approval_preset",
            "set_codex_sandbox_selection",
            "execute_codex_plan",
            "codex_compact",
            "codex_review",
            "codex_preconnect",
            "codex_release_thread"
    };

    /** Creates an interaction router for the current chat window. */
    public CodexInteractionHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    @Override
    public boolean handle(String type, String content) {
        if ("codex_interaction_response".equals(type)) {
            handleInteractionResponse(content, false);
            return true;
        }
        if ("codex_interaction_error".equals(type)) {
            handleInteractionResponse(content, true);
            return true;
        }
        if ("codex_interaction_delivery_ack".equals(type)) {
            handleDeliveryAcknowledgement(content);
            return true;
        }
        if ("codex_runtime_frontend_ready".equals(type)) {
            handleFrontendReady(content);
            return true;
        }
        if ("codex_abort_turn".equals(type)) {
            handleAbortTurn(content);
            return true;
        }
        if ("codex_update_settings".equals(type)) {
            handleUpdateSettings(content);
            return true;
        }
        if ("set_codex_collaboration_mode".equals(type)
                || "set_codex_approval_preset".equals(type)
                || "set_codex_sandbox_selection".equals(type)) {
            handleNativeSetting(type, content);
            return true;
        }
        if ("execute_codex_plan".equals(type)) {
            handleExecutePlan(content);
            return true;
        }
        if ("codex_compact".equals(type) || "codex_review".equals(type)) {
            handleLongOperation(type, content);
            return true;
        }
        if ("codex_preconnect".equals(type) || "codex_release_thread".equals(type)) {
            handleLifecycleOperation(type, content);
            return true;
        }
        return false;
    }

    private void handleDeliveryAcknowledgement(String content) {
        JsonObject payload = parseObject(content);
        if (payload == null) {
            return;
        }
        String interactionKey = stringValue(payload, "interactionKey");
        String dialogToken = stringValue(payload, "dialogToken");
        String phase = stringValue(payload, "phase");
        long sequence = payload.has("deliverySequence") && payload.get("deliverySequence").isJsonPrimitive()
                ? payload.get("deliverySequence").getAsLong() : -1L;
        if (interactionKey == null || dialogToken == null || sequence < 0L
                || (!"show".equals(phase) && !"close".equals(phase))) {
            LOG.debug("[CodexInteraction] Ignoring malformed delivery acknowledgement");
            return;
        }
        CodexSDKBridge bridge = this.context.getCodexSDKBridge();
        if (bridge != null && !bridge.acknowledgeCodexInteractionDelivery(
                interactionKey, dialogToken, sequence, phase)) {
            LOG.debug("[CodexInteraction] Ignoring stale delivery acknowledgement");
        }
    }

    private void handleFrontendReady(String content) {
        JsonObject payload = parseObject(content);
        ClaudeSession session = this.context.getSession();
        String channelId = nonEmpty(stringValue(payload, "channelId"),
                session == null ? null : session.getChannelId());
        long pageGeneration = payload != null && payload.has("pageGeneration")
                && payload.get("pageGeneration").isJsonPrimitive()
                ? payload.get("pageGeneration").getAsLong() : 0L;
        CodexSDKBridge bridge = this.context.getCodexSDKBridge();
        if (bridge != null && channelId != null && !channelId.trim().isEmpty()) {
            bridge.refreshCodexInteractionPage(channelId, pageGeneration);
        }
    }

    private void handleInteractionResponse(String content, boolean errorResponse) {
        JsonObject payload = parseObject(content);
        if (payload == null) {
            return;
        }
        String interactionKey = stringValue(payload, "interactionKey");
        String dialogToken = stringValue(payload, "dialogToken");
        if (interactionKey == null || interactionKey.isEmpty()) {
            LOG.warn("[CodexInteraction] Ignoring response without interactionKey");
            return;
        }
        ClaudeSession session = this.context.getSession();
        String channelId = nonEmpty(stringValue(payload, "channelId"), session == null ? null : session.getChannelId());
        String cwd = nonEmpty(stringValue(payload, "cwd"), session == null ? null : session.getCwd());
        CodexSDKBridge bridge = this.context.getCodexSDKBridge();
        if (bridge == null) {
            return;
        }

        java.util.concurrent.CompletableFuture
                .supplyAsync(() -> {
                    JsonObject acknowledgement;
                    if (errorResponse) {
                        acknowledgement = bridge.rejectCodexInteraction(
                                channelId, cwd, interactionKey, dialogToken, parseErrorCode(payload),
                                stringValue(payload, "message"));
                    } else {
                        JsonObject result = payload.has("result") && payload.get("result").isJsonObject()
                                ? payload.getAsJsonObject("result") : new JsonObject();
                        acknowledgement = bridge.respondCodexInteraction(channelId, cwd, interactionKey, dialogToken, result);
                    }
                    return acknowledgement;
                }, CodexSDKBridge.codexControlExecutor())
                .thenAccept(acknowledgement -> this.notifyResult(acknowledgement, interactionKey))
                // A silently dropped answer would leave the native request waiting
                // until thread release; always report back to the page.
                .exceptionally(failure -> {
                    Throwable cause = failure.getCause() != null ? failure.getCause() : failure;
                    LOG.warn("[CodexInteraction] Failed to deliver interaction response: " + cause);
                    this.notifyResult(errorResult(cause.getMessage() == null
                            ? "Codex interaction response failed" : cause.getMessage()), interactionKey);
                    return null;
                });
    }

    /** Non-numeric or missing codes fall back to the generic server error code. */
    private static int parseErrorCode(JsonObject payload) {
        try {
            return payload.has("code") && payload.get("code").isJsonPrimitive()
                    && payload.get("code").getAsJsonPrimitive().isNumber()
                    ? payload.get("code").getAsInt() : -32800;
        } catch (Exception ignored) {
            return -32800;
        }
    }

    private void handleAbortTurn(String content) {
        JsonObject payload = parseObject(content);
        ClaudeSession session = this.context.getSession();
        String channelId = nonEmpty(payload == null ? null : stringValue(payload, "channelId"),
                session == null ? null : session.getChannelId());
        String cwd = nonEmpty(payload == null ? null : stringValue(payload, "cwd"),
                session == null ? null : session.getCwd());
        CodexSDKBridge bridge = this.context.getCodexSDKBridge();
        if (bridge != null) {
            // Blocking daemon round-trips (up to ~40s incl. daemon cold start)
            // must never run on the JCEF UI thread that serializes all
            // webview→Java messages.
            java.util.concurrent.CompletableFuture
                    .supplyAsync(() -> bridge.abortCodexTurn(channelId, cwd), CodexSDKBridge.codexControlExecutor())
                    .thenAccept(acknowledgement -> this.notifyResult(acknowledgement, null));
        }
    }

    private void handleUpdateSettings(String content) {
        JsonObject payload = parseObject(content);
        if (payload == null) {
            return;
        }
        ClaudeSession session = this.context.getSession();
        String channelId = nonEmpty(stringValue(payload, "channelId"), session == null ? null : session.getChannelId());
        String cwd = nonEmpty(stringValue(payload, "cwd"), session == null ? null : session.getCwd());
        JsonObject settings = payload.has("settings") && payload.get("settings").isJsonObject()
                ? payload.getAsJsonObject("settings") : new JsonObject();
        CodexSDKBridge bridge = this.context.getCodexSDKBridge();
        if (bridge != null) {
            java.util.concurrent.CompletableFuture
                    .supplyAsync(() -> bridge.updateCodexSettings(channelId, cwd, settings), CodexSDKBridge.codexControlExecutor())
                    .thenAccept(acknowledgement -> this.notifyResult(acknowledgement, null));
        }
    }

    private void handleNativeSetting(String type, String content) {
        ClaudeSession session = this.context.getSession();
        String channelId = session == null ? null : session.getChannelId();
        String cwd = session == null ? null : session.getCwd();
        JsonObject settings = new JsonObject();
        if ("set_codex_collaboration_mode".equals(type)) {
            String mode = content == null ? "default" : content.trim();
            if (!"plan".equals(mode) && !"default".equals(mode)) {
                notifyResult(errorResult("Unsupported collaboration mode"), null);
                return;
            }
            settings.addProperty("collaborationMode", mode);
        } else if ("set_codex_approval_preset".equals(type)) {
            String preset = content == null ? "request" : content.trim();
            if (!Set.of("request", "auto", "sandboxed-auto", "full-access").contains(preset)) {
                notifyResult(errorResult("Unsupported approval preset"), null);
                return;
            }
            settings.addProperty("approvalPreset", preset);
        } else {
            JsonObject selection = parseObject(content);
            String value = selection == null ? "" : stringValue(selection, "selection");
            if (!Set.of("read-only", "workspace-write", "danger-full-access").contains(value)) {
                notifyResult(errorResult("Unsupported sandbox selection"), null);
                return;
            }
            settings.addProperty("sandboxSelection", value);
            if (selection.has("source")) {
                settings.add("sandboxSource", selection.get("source"));
            }
        }
        CodexSDKBridge bridge = this.context.getCodexSDKBridge();
        if (bridge == null) {
            notifyResult(errorResult("Codex bridge is unavailable"), null);
            return;
        }
        java.util.concurrent.CompletableFuture
                .supplyAsync(() -> bridge.updateCodexSettings(channelId, cwd, settings), CodexSDKBridge.codexControlExecutor())
                .thenAccept(acknowledgement -> this.notifyResult(acknowledgement, null));
    }

    private static JsonObject errorResult(String message) {
        JsonObject result = new JsonObject();
        result.addProperty("error", message);
        return result;
    }

    private void handleExecutePlan(String content) {
        JsonObject payload = parseObject(content);
        ClaudeSession session = this.context.getSession();
        String channelId = nonEmpty(stringValue(payload, "channelId"),
                session == null ? null : session.getChannelId());
        String cwd = nonEmpty(stringValue(payload, "cwd"), session == null ? null : session.getCwd());
        String threadId = nonEmpty(stringValue(payload, "threadId"),
                session == null ? null : session.getSessionId());
        String requestId = stringValue(payload, "requestId");
        CodexSDKBridge bridge = this.context.getCodexSDKBridge();
        if (bridge == null) {
            this.notifyOperationResult(errorResult("Codex bridge is unavailable"), "execute_codex_plan", threadId, requestId);
            return;
        }
        String planItemId = stringValue(payload, "planItemId");
        String planText = stringValue(payload, "planText");
        if (planItemId == null || planItemId.trim().isEmpty()
                || planText == null || planText.trim().isEmpty()) {
            this.notifyOperationResult(errorResult("A current plan item and plan text are required"),
                    "execute_codex_plan", threadId, requestId);
            return;
        }
        // The synchronous prologue of executeCodexPlan may cold-start the daemon
        // (up to ~40s); that must never run on the JCEF message-dispatch thread.
        java.util.concurrent.CompletableFuture
                .supplyAsync(() -> bridge.executeCodexPlan(channelId, cwd, threadId, planItemId, planText),
                        CodexSDKBridge.codexControlExecutor())
                .thenCompose(operation -> operation)
                .whenComplete((result, failure) -> {
                    JsonObject output = result == null ? new JsonObject() : result.deepCopy();
                    if (failure != null) {
                        output.addProperty("error", failure.getMessage() == null
                                ? "Codex plan execution failed" : failure.getMessage());
                    }
                    this.notifyOperationResult(output, "execute_codex_plan", threadId, requestId);
                });
    }

    private void handleLongOperation(String type, String content) {
        JsonObject payload = parseObject(content);
        ClaudeSession session = this.context.getSession();
        String channelId = nonEmpty(payload == null ? null : stringValue(payload, "channelId"),
                session == null ? null : session.getChannelId());
        String cwd = nonEmpty(payload == null ? null : stringValue(payload, "cwd"),
                session == null ? null : session.getCwd());
        String threadId = nonEmpty(payload == null ? null : stringValue(payload, "threadId"),
                session == null ? null : session.getSessionId());
        String requestId = stringValue(payload, "requestId");
        CodexSDKBridge bridge = this.context.getCodexSDKBridge();
        if (bridge == null) {
            // The page optimistically announced the operation; a silent drop
            // would leave its status waiting forever.
            this.notifyOperationResult(errorResult("Codex bridge is unavailable"), type, threadId, requestId);
            return;
        }
        MessageCallback callback;
        Object controlTurnOwner;
        if (session != null) {
            synchronized (session.getState().getMessageStateLock()) {
                if (!java.util.Objects.equals(threadId, session.getSessionId())) {
                    this.notifyOperationResult(errorResult("The requested Codex thread is no longer selected"),
                            type, threadId, requestId);
                    return;
                }
                if (!session.setCodexControlWaiting(true)) {
                    this.notifyOperationResult(errorResult("Wait for the current Codex operation to finish"),
                            type, threadId, requestId);
                    return;
                }
                // Capture ownership before dispatch: a send may start while the
                // background task is still preparing its daemon request.
                callback = session.createCodexControlCallback();
                controlTurnOwner = session.getState().getTurnOwner();
            }
        } else {
            callback = null;
            controlTurnOwner = null;
        }
        // Same JCEF-thread rule as handleExecutePlan: keep the daemon round-trip
        // prologue off the message-dispatch thread.
        java.util.concurrent.CompletableFuture
                .supplyAsync(() -> "codex_compact".equals(type)
                        ? bridge.compactCodex(channelId, cwd, threadId, callback)
                        : bridge.reviewCodex(channelId, cwd, threadId, callback),
                        CodexSDKBridge.codexControlExecutor())
                .thenCompose(operation -> operation)
                .whenComplete((result, error) -> {
                    if (session != null && this.context.getSession() == session
                            && java.util.Objects.equals(threadId, session.getSessionId())) {
                        synchronized (session.getState().getMessageStateLock()) {
                            if (session.getState().isCurrentTurn(controlTurnOwner)) {
                                session.setCodexControlWaiting(false);
                            }
                        }
                    }
                    JsonObject response = result == null ? new JsonObject() : result.deepCopy();
                    if (error != null) {
                        Throwable cause = error;
                        while ((cause instanceof java.util.concurrent.CompletionException
                                || cause instanceof java.util.concurrent.ExecutionException) && cause.getCause() != null) {
                            cause = cause.getCause();
                        }
                        response.addProperty("error", cause.getMessage() == null ? "Codex operation failed" : cause.getMessage());
                    }
                    this.notifyOperationResult(response, type, threadId, requestId);
                });
    }

    private void handleLifecycleOperation(String type, String content) {
        JsonObject payload = parseObject(content);
        ClaudeSession session = this.context.getSession();
        String channelId = nonEmpty(payload == null ? null : stringValue(payload, "channelId"),
                session == null ? null : session.getChannelId());
        String cwd = nonEmpty(payload == null ? null : stringValue(payload, "cwd"),
                session == null ? null : session.getCwd());
        String threadId = nonEmpty(payload == null ? null : stringValue(payload, "threadId"),
                session == null ? null : session.getSessionId());
        CodexSDKBridge bridge = this.context.getCodexSDKBridge();
        if (bridge == null) {
            notifyResult(errorResult("Codex bridge is unavailable"), null);
            return;
        }
        // Same JCEF-thread rule as handleExecutePlan: keep the daemon round-trip
        // prologue off the message-dispatch thread.
        java.util.concurrent.CompletableFuture
                .supplyAsync(() -> "codex_preconnect".equals(type)
                        ? bridge.preconnectCodex(channelId, cwd, threadId)
                        : bridge.releaseCodexThread(channelId, cwd, threadId),
                        CodexSDKBridge.codexControlExecutor())
                .thenCompose(operation -> operation)
                .whenComplete((result, error) -> {
                    JsonObject response = result == null ? new JsonObject() : result.deepCopy();
                    if (error != null) {
                        response.addProperty("error", error.getMessage() == null ? "Codex lifecycle operation failed" : error.getMessage());
                    }
                    notifyResult(response, null);
                });
    }

    private void notifyOperationResult(JsonObject response, String type, String threadId, String requestId) {
        // A delayed result belongs to its submitted request, even after the page selects another chat.
        JsonObject result = response == null ? new JsonObject() : response.deepCopy();
        result.addProperty("requestType", type);
        result.addProperty("threadId", threadId);
        result.addProperty("requestId", requestId);
        this.notifyResult(result, null);
    }

    private void notifyResult(JsonObject acknowledgement, String interactionKey) {
        JsonObject result = acknowledgement == null ? new JsonObject() : acknowledgement.deepCopy();
        if (interactionKey != null) {
            result.addProperty("interactionKey", interactionKey);
        }
        callJavaScript("onCodexInteractionResponse", escapeJs(GSON.toJson(result)));
    }

    private static JsonObject parseObject(String content) {
        try {
            return content == null || content.trim().isEmpty()
                    ? new JsonObject() : GSON.fromJson(content, JsonObject.class);
        } catch (Exception e) {
            return null;
        }
    }

    private static String stringValue(JsonObject object, String name) {
        return object != null && object.has(name) && !object.get(name).isJsonNull()
                ? object.get(name).getAsString() : null;
    }

    private static String nonEmpty(String preferred, String fallback) {
        return preferred == null || preferred.trim().isEmpty() ? fallback : preferred;
    }
}

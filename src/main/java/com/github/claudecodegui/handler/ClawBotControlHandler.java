package com.github.claudecodegui.handler;

import com.github.claudecodegui.clawbot.ClawBotGatewayRuntimeService;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.IOException;
import java.util.concurrent.CompletableFuture;

/** Handles explicit, user-triggered iLink binding operations. */
public final class ClawBotControlHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {
            "clawbot_start_pairing",
            "clawbot_poll_pairing",
            "clawbot_cancel_pairing",
            "clawbot_start_transport",
            "clawbot_unbind",
            "clawbot_allow_sender",
            "clawbot_revoke_sender",
            "clawbot_list_senders",
            "clawbot_update_progress_settings",
            "clawbot_list_reply_recovery",
            "clawbot_retry_reply"
    };

    public ClawBotControlHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    @Override
    public boolean handle(String type, String content) {
        if (!matchesType(type, SUPPORTED_TYPES)) {
            return false;
        }
        String operation = operationFor(type);
        JsonObject payload;
        try {
            payload = parsePayload(content);
        } catch (RuntimeException error) {
            CompletableFuture.runAsync(() -> publish(operation, false, "CLAWBOT_REQUEST_INVALID", currentStatus()),
                    AppExecutorUtil.getAppExecutorService());
            return true;
        }
        CompletableFuture.runAsync(() -> execute(operation, payload), AppExecutorUtil.getAppExecutorService());
        return true;
    }

    private void execute(String operation, JsonObject payload) {
        try {
            JsonObject result = ClawBotGatewayRuntimeService.getInstance().control(operation, payload);
            publish(operation, true, null, result);
        } catch (IOException | RuntimeException error) {
            publish(operation, false, safeErrorCode(error.getMessage()), currentStatus());
        }
    }

    private void publish(String operation, boolean success, String errorCode, JsonObject status) {
        JsonObject result = new JsonObject();
        result.addProperty("operation", operation.toLowerCase(java.util.Locale.ROOT));
        result.addProperty("ok", success);
        if (errorCode != null) {
            result.addProperty("errorCode", errorCode);
        }
        JsonObject safeStatus = status == null ? currentStatus() : status.deepCopy();
        if ("list_senders".equals(operation.toLowerCase(java.util.Locale.ROOT))) {
            copyListResult(status, result, "authorizedSenders");
            copyListResult(status, result, "senderOffset");
            copyListResult(status, result, "senderHasMore");
            copyListResult(status, result, "senderTotalCount");
            copyListResult(status, result, "senderLastUsedAt");
            safeStatus.remove("authorizedSenders");
            safeStatus.remove("senderOffset");
            safeStatus.remove("senderHasMore");
            safeStatus.remove("senderTotalCount");
            safeStatus.remove("senderLastUsedAt");
        }
        if ("LIST_REPLY_RECOVERY".equals(operation) || "RETRY_REPLY".equals(operation)) {
            copyListResult(status, result, "replyRecoveryItems");
            copyListResult(status, result, "replyRecoveryAvailable");
            copyListResult(status, result, "replyRecoveryBindingRevision");
            safeStatus.remove("replyRecoveryItems");
            safeStatus.remove("replyRecoveryAvailable");
            safeStatus.remove("replyRecoveryBindingRevision");
        }
        String operationJson = result.toString();
        String statusJson = safeStatus.toString();
        ApplicationManager.getApplication().invokeLater(() -> {
            if (context.isDisposed()) {
                return;
            }
            callJavaScript("window.onClawBotOperation", escapeJs(operationJson));
            callJavaScript("window.onClawBotStatus", escapeJs(statusJson));
        });
    }

    private static void copyListResult(JsonObject source, JsonObject destination, String property) {
        if (source != null && source.has(property)) {
            destination.add(property, source.get(property).deepCopy());
        }
    }

    private JsonObject currentStatus() {
        try {
            return ClawBotGatewayRuntimeService.getInstance().statusSnapshot();
        } catch (RuntimeException ignored) {
            JsonObject status = new JsonObject();
            status.addProperty("state", "STOPPED");
            status.addProperty("transport", "MOCK");
            status.addProperty("transportState", "STOPPED");
            status.addProperty("sessionCount", 0);
            status.addProperty("senderAccessCount", 0);
            status.addProperty("bindingState", "UNKNOWN");
            status.addProperty("bindingRevision", 0);
            status.addProperty("pairingState", "IDLE");
            status.addProperty("pairingAttempt", 0);
            status.add("pairing", new JsonObject());
            return status;
        }
    }

    private static JsonObject parsePayload(String content) {
        if (content == null || content.isBlank()) {
            return new JsonObject();
        }
        if (content.length() > 4096) {
            throw new IllegalArgumentException("payload too large");
        }
        com.google.gson.JsonElement parsed = JsonParser.parseString(content);
        if (!parsed.isJsonObject()) {
            throw new IllegalArgumentException("payload must be an object");
        }
        return parsed.getAsJsonObject();
    }

    private static String operationFor(String type) {
        return type.substring("clawbot_".length()).toUpperCase(java.util.Locale.ROOT);
    }

    private static String safeErrorCode(String value) {
        if (value == null || value.isBlank() || value.length() > 128) {
            return "CLAWBOT_OPERATION_FAILED";
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (!((character >= 'A' && character <= 'Z')
                    || (character >= '0' && character <= '9') || character == '_')) {
                return "CLAWBOT_OPERATION_FAILED";
            }
        }
        return value;
    }
}

package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.service.CodexSubscriptionQuotaService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Sends Codex subscription quota snapshots to the WebView.
 */
public class CodexSubscriptionQuotaHandler {

    private static final Logger LOG = Logger.getInstance(CodexSubscriptionQuotaHandler.class);
    private static final Gson GSON = new Gson();

    private final HandlerContext context;

    public CodexSubscriptionQuotaHandler(HandlerContext context) {
        this.context = context;
    }

    public void handleGetCodexSubscriptionQuota() {
        ApplicationManager.getApplication()
                .getService(CodexSubscriptionQuotaService.class)
                .getQuotaSnapshot()
                .thenAccept(this::sendPayload)
                .exceptionally(e -> {
                    // Unwrap CompletionException so the WebView shows the cause
                    // message instead of "java.lang.XxxException: ...".
                    Throwable cause = e.getCause() != null ? e.getCause() : e;
                    LOG.warn("[CodexSubscriptionQuotaHandler] Failed to load quota: " + cause.getMessage());
                    sendPayload(CodexSubscriptionQuotaService.buildUnavailablePayload(cause.getMessage(), System.currentTimeMillis()));
                    return null;
                });
    }

    private void sendPayload(JsonObject payload) {
        ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.updateCodexSubscriptionQuota", context.escapeJs(GSON.toJson(payload))));
    }
}

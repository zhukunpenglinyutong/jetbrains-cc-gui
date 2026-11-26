package com.github.claudecodegui.handler.provider.codex;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexPlanUsageService;
import com.github.claudecodegui.service.CodexSubscriptionQuotaService;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;

/**
 * Bridges the webview's {@code get_codex_plan_usage} poll to
 * {@link CodexPlanUsageService} and pushes the snapshot back via
 * {@code window.updateCodexPlanUsage}. Mirrors {@code ClaudePlanUsageHandler}
 * and {@code GeminiPlanUsageHandler}.
 *
 * <p>The poll's content is an opaque request id (the webview's poll
 * generation); it is echoed as {@code request_id} so the webview can discard
 * replies from superseded polls that arrive out of order.
 */
public class CodexPlanUsageHandler extends BaseMessageHandler {

    /** Dispatch type the webview polls with ({@code get_codex_plan_usage:<requestId>}). */
    static final String DISPATCH_TYPE = "get_codex_plan_usage";

    /** JS callback the snapshot is pushed through. Contract-pinned by tests. */
    static final String CODEX_PLAN_USAGE_CALLBACK = "window.updateCodexPlanUsage";

    private static final String[] SUPPORTED_TYPES = {
            DISPATCH_TYPE
    };

    public CodexPlanUsageHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if (!DISPATCH_TYPE.equals(type)) {
            return false;
        }
        if (isContextDisposed()) {
            return true;
        }
        String requestId = content == null ? "" : content.trim();
        Application application = ApplicationManager.getApplication();
        if (application == null) {
            return true;
        }
        application.executeOnPooledThread(() -> {
            if (isContextDisposed()) {
                return;
            }
            try {
                ClaudeSession session = context.getSession();
                String supplierId = (session == null || session.getState() == null)
                        ? null
                        : session.getState().getRuntimeSupplierId("codex");
                CodexSubscriptionQuotaService quotaService =
                        application.getService(CodexSubscriptionQuotaService.class);
                CodexPlanUsageService.resolvePlanUsagePayloadAsync(quotaService, supplierId)
                        .whenComplete((usage, error) -> {
                            if (isContextDisposed()) {
                                return;
                            }
                            JsonObject payload = usage;
                            if (payload == null) {
                                Throwable cause = error != null && error.getCause() != null ? error.getCause() : error;
                                payload = new JsonObject();
                                payload.addProperty("error", true);
                                if (cause != null && cause.getMessage() != null) {
                                    payload.addProperty("message", cause.getMessage());
                                }
                            }
                            echoRequestId(payload, requestId);
                            context.callJavaScript(CODEX_PLAN_USAGE_CALLBACK, context.escapeJs(payload.toString()));
                        });
            } catch (Exception e) {
                if (!isContextDisposed()) {
                    JsonObject error = new JsonObject();
                    error.addProperty("error", true);
                    error.addProperty("message", e.getMessage());
                    echoRequestId(error, requestId);
                    context.callJavaScript(CODEX_PLAN_USAGE_CALLBACK, context.escapeJs(error.toString()));
                }
            }
        });
        return true;
    }

    private static void echoRequestId(JsonObject payload, String requestId) {
        if (!requestId.isEmpty()) {
            payload.addProperty("request_id", requestId);
        }
    }

    private boolean isContextDisposed() {
        return context == null
                || context.isDisposed()
                || (context.getProject() != null && context.getProject().isDisposed());
    }
}

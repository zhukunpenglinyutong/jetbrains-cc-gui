package com.github.claudecodegui.handler.provider.claude;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.claude.ClaudePlanUsageService;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;

/**
 * Bridges the webview's {@code get_claude_plan_usage} poll to
 * {@link ClaudePlanUsageService} and pushes the snapshot back via
 * {@code window.updateClaudePlanUsage}. Mirrors {@code GeminiPlanUsageHandler}.
 *
 * <p>The poll's content is an opaque request id (the webview's poll
 * generation); it is echoed as {@code request_id} so the webview can discard
 * replies from superseded polls that arrive out of order.
 */
public class ClaudePlanUsageHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {
            "get_claude_plan_usage"
    };

    public ClaudePlanUsageHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("get_claude_plan_usage".equals(type)) {
            String requestId = content == null ? "" : content.trim();
            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                try {
                    JsonObject usage = ClaudePlanUsageService.resolvePlanUsagePayload(context.getSettingsService());
                    if (usage == null) {
                        usage = new JsonObject();
                        usage.addProperty("error", true);
                    }
                    echoRequestId(usage, requestId);
                    context.callJavaScript("window.updateClaudePlanUsage", context.escapeJs(usage.toString()));
                } catch (Exception e) {
                    JsonObject error = new JsonObject();
                    error.addProperty("error", true);
                    error.addProperty("message", e.getMessage());
                    echoRequestId(error, requestId);
                    context.callJavaScript("window.updateClaudePlanUsage", context.escapeJs(error.toString()));
                }
            });
            return true;
        }
        return false;
    }

    private static void echoRequestId(JsonObject payload, String requestId) {
        if (!requestId.isEmpty()) {
            payload.addProperty("request_id", requestId);
        }
    }
}

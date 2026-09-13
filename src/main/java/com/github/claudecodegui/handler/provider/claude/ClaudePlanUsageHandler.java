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
            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                try {
                    JsonObject usage = ClaudePlanUsageService.resolvePlanUsagePayload(context.getSettingsService());
                    if (usage == null) {
                        usage = new JsonObject();
                        usage.addProperty("error", true);
                    }
                    context.callJavaScript("window.updateClaudePlanUsage", context.escapeJs(usage.toString()));
                } catch (Exception e) {
                    JsonObject error = new JsonObject();
                    error.addProperty("error", true);
                    error.addProperty("message", e.getMessage());
                    context.callJavaScript("window.updateClaudePlanUsage", context.escapeJs(error.toString()));
                }
            });
            return true;
        }
        return false;
    }
}

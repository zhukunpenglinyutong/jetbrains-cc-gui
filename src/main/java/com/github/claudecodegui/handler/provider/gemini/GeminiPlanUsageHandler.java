package com.github.claudecodegui.handler.provider.gemini;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.gemini.GeminiPlanUsageService;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;

/**
 * Bridges the webview's {@code get_gemini_plan_usage} poll to
 * {@link GeminiPlanUsageService} and pushes the snapshot back via
 * {@code window.updateGeminiPlanUsage}. Mirrors {@code ClaudePlanUsageHandler}.
 *
 * <p>The poll content carries the selected model slug
 * ({@code get_gemini_plan_usage:<slug>}) so the service can resolve the
 * billing family — quota display follows the model selection.
 */
public class GeminiPlanUsageHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {
            "get_gemini_plan_usage"
    };

    public GeminiPlanUsageHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("get_gemini_plan_usage".equals(type)) {
            String selectedModelSlug = content != null ? content.trim() : "";
            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                try {
                    JsonObject usage = GeminiPlanUsageService.resolvePlanUsagePayload(selectedModelSlug);
                    if (usage == null) {
                        usage = new JsonObject();
                        usage.addProperty("error", true);
                    }
                    context.callJavaScript("window.updateGeminiPlanUsage", context.escapeJs(usage.toString()));
                } catch (Exception e) {
                    JsonObject error = new JsonObject();
                    error.addProperty("error", true);
                    error.addProperty("message", e.getMessage());
                    context.callJavaScript("window.updateGeminiPlanUsage", context.escapeJs(error.toString()));
                }
            });
            return true;
        }
        return false;
    }
}

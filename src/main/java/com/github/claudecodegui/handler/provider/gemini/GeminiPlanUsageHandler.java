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

    /** Dispatch type the webview polls with ({@code get_gemini_plan_usage:<slug>}). */
    static final String DISPATCH_TYPE = "get_gemini_plan_usage";
    /**
     * JS callback the snapshot is pushed through. Contract-pinned by
     * {@code GeminiPlanUsageHandlerCallbackTest} (precedent:
     * {@code CodexMcpServerHandlerCallbackTest}) so a rename cannot silently
     * kill the indicator while the suites stay green.
     */
    static final String GEMINI_PLAN_USAGE_CALLBACK = "window.updateGeminiPlanUsage";

    private static final String[] SUPPORTED_TYPES = {
            DISPATCH_TYPE
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
        if (DISPATCH_TYPE.equals(type)) {
            String selectedModelSlug = content != null ? content.trim() : "";
            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                try {
                    JsonObject usage = GeminiPlanUsageService.resolvePlanUsagePayload(selectedModelSlug);
                    if (usage == null) {
                        usage = new JsonObject();
                        usage.addProperty("error", true);
                    }
                    context.callJavaScript(GEMINI_PLAN_USAGE_CALLBACK, context.escapeJs(usage.toString()));
                } catch (Exception e) {
                    JsonObject error = new JsonObject();
                    error.addProperty("error", true);
                    error.addProperty("message", e.getMessage());
                    context.callJavaScript(GEMINI_PLAN_USAGE_CALLBACK, context.escapeJs(error.toString()));
                }
            });
            return true;
        }
        return false;
    }
}

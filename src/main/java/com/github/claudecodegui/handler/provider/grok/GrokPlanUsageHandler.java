package com.github.claudecodegui.handler.provider.grok;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.grok.GrokPlanUsageService;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;

/**
 * Bridges the webview's {@code get_grok_plan_usage} poll to
 * {@link GrokPlanUsageService} and pushes the snapshot back via
 * {@code window.updateGrokPlanUsage}.
 */
public class GrokPlanUsageHandler extends BaseMessageHandler {

    static final String DISPATCH_TYPE = "get_grok_plan_usage";
    static final String CALLBACK = "window.updateGrokPlanUsage";

    private static final String[] SUPPORTED_TYPES = {
            DISPATCH_TYPE
    };

    public GrokPlanUsageHandler(HandlerContext context) {
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
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                String cwd = context.getProject() != null ? context.getProject().getBasePath() : null;
                JsonObject usage = GrokPlanUsageService.resolvePlanUsagePayload(
                        context.getGrokSDKBridge(), cwd);
                if (usage == null) {
                    usage = new JsonObject();
                    usage.addProperty("error", true);
                }
                context.callJavaScript(CALLBACK, context.escapeJs(usage.toString()));
            } catch (Exception e) {
                JsonObject error = new JsonObject();
                error.addProperty("error", true);
                error.addProperty("message", e.getMessage());
                context.callJavaScript(CALLBACK, context.escapeJs(error.toString()));
            }
        });
        return true;
    }
}

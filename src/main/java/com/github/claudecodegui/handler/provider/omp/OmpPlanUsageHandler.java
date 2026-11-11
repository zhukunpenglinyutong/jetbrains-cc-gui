package com.github.claudecodegui.handler.provider.omp;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.omp.OmpPlanUsageService;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;

/**
 * Bridges the webview's {@code get_omp_plan_usage} poll to {@link OmpPlanUsageService}
 * and pushes the capacity payload back via {@code window.updateOmpPlanUsage}.
 */
public class OmpPlanUsageHandler extends BaseMessageHandler {

    static final String DISPATCH_TYPE = "get_omp_plan_usage";
    static final String CALLBACK = "window.updateOmpPlanUsage";

    private static final String[] SUPPORTED_TYPES = {
            DISPATCH_TYPE
    };

    public OmpPlanUsageHandler(HandlerContext context) {
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
            if (context.isDisposed() || (context.getProject() != null && context.getProject().isDisposed())) {
                return;
            }
            try {
                JsonObject usage = OmpPlanUsageService.resolvePlanUsagePayload(resolveModel(context));
                if (!context.isDisposed()) {
                    context.callJavaScript(CALLBACK, context.escapeJs(usage.toString()));
                }
            } catch (Exception e) {
                if (!context.isDisposed()) {
                    JsonObject error = new JsonObject();
                    error.addProperty("present", false);
                    error.addProperty("unavailable", true);
                    error.addProperty("error", true);
                    error.addProperty("message", e.getMessage());
                    context.callJavaScript(CALLBACK, context.escapeJs(error.toString()));
                }
            } finally {
                Thread.interrupted();
            }
        });
        return true;
    }

    /** The session's model wins over the handler context, which can still hold the startup default. */
    static String resolveModel(HandlerContext context) {
        if (context.getSession() != null) {
            String sessionModel = context.getSession().getModel();
            if (sessionModel != null && !sessionModel.isEmpty()) {
                return sessionModel;
            }
        }
        String contextModel = context.getCurrentModel();
        return contextModel != null ? contextModel : "";
    }
}

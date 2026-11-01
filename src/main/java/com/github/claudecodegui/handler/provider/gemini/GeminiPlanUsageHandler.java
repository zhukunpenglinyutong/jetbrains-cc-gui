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

    private static final String ERROR_KEY = "error";

    private static final String[] SUPPORTED_TYPES = {
            DISPATCH_TYPE
    };

    /**
     * Creates a new Gemini plan-usage message handler bound to the given context.
     *
     * @param context Active handler context providing webview callback and disposal state
     */
    public GeminiPlanUsageHandler(HandlerContext context) {
        super(context);
    }

    /**
     * Returns the message dispatch types handled by this handler.
     *
     * @return supported message dispatch type identifiers
     */
    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    /**
     * Handles a {@code get_gemini_plan_usage} request asynchronously and pushes the snapshot to the webview.
     *
     * @param type Message dispatch type
     * @param content Selected model slug payload
     * @return {@code true} when the message type is handled by this handler
     */
    @Override
    public boolean handle(String type, String content) {
        if (!DISPATCH_TYPE.equals(type)) {
            return false;
        }
        if (isContextDisposed()) {
            return true;
        }
        String selectedModelSlug = content != null ? content.trim() : "";
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            if (isContextDisposed()) {
                return;
            }
            try {
                JsonObject usage = GeminiPlanUsageService.resolvePlanUsagePayload(selectedModelSlug);
                if (usage == null) {
                    usage = new JsonObject();
                    usage.addProperty(ERROR_KEY, true);
                }
                if (!isContextDisposed()) {
                    context.callJavaScript(GEMINI_PLAN_USAGE_CALLBACK, context.escapeJs(usage.toString()));
                }
            } catch (Exception e) {
                if (!isContextDisposed()) {
                    JsonObject error = new JsonObject();
                    error.addProperty(ERROR_KEY, true);
                    error.addProperty("message", e.getMessage());
                    context.callJavaScript(GEMINI_PLAN_USAGE_CALLBACK, context.escapeJs(error.toString()));
                }
            }
        });
        return true;
    }

    private boolean isContextDisposed() {
        return context == null
                || context.isDisposed()
                || (context.getProject() != null && context.getProject().isDisposed());
    }
}

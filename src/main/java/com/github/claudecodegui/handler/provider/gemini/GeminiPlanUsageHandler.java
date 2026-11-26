package com.github.claudecodegui.handler.provider.gemini;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.gemini.GeminiPlanUsageService;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/** Delivers the Antigravity quota snapshot to the page that requested it. */
public class GeminiPlanUsageHandler extends BaseMessageHandler {

    static final String DISPATCH_TYPE = "get_gemini_plan_usage";
    static final String GEMINI_PLAN_USAGE_CALLBACK = "window.updateGeminiPlanUsage";
    private static final Pattern REQUEST_ID = Pattern.compile("[0-9]{1,16}");
    private final Supplier<CompletableFuture<JsonObject>> fetchQuota;

    /** Creates the quota request handler for the given chat window. */
    public GeminiPlanUsageHandler(HandlerContext context) {
        this(context, GeminiPlanUsageService::requestPlanUsage);
    }

    GeminiPlanUsageHandler(HandlerContext context, Supplier<CompletableFuture<JsonObject>> fetchQuota) {
        super(context);
        this.fetchQuota = fetchQuota;
    }

    /** Returns the dispatch type used by the Antigravity quota panel. */
    @Override
    public String[] getSupportedTypes() {
        return new String[]{DISPATCH_TYPE};
    }

    /** Schedules a quota query and echoes the request ID so a reopened panel cannot accept an old reply. */
    @Override
    public boolean handle(String type, String content) {
        if (!DISPATCH_TYPE.equals(type)) {
            return false;
        }
        if (this.isContextDisposed() || content == null || !REQUEST_ID.matcher(content).matches()) {
            return true;
        }
        HandlerContext.JsSender reply = this.context.captureJavaScriptExecutor();
        this.fetchQuota.get().whenComplete((quota, error) -> {
            if (this.isContextDisposed()) {
                return;
            }
            if (error != null || quota == null) {
                quota = new JsonObject();
                quota.addProperty("status", "unavailable");
                quota.addProperty("reasonCode", "query_failed");
            }
            reply.send(GEMINI_PLAN_USAGE_CALLBACK + "?.(" + new JsonPrimitive(content) + ", " + new JsonPrimitive(quota.toString()) + ");");
        });
        return true;
    }

    private boolean isContextDisposed() {
        return this.context == null
                || this.context.isDisposed()
                || (this.context.getProject() != null && this.context.getProject().isDisposed());
    }
}

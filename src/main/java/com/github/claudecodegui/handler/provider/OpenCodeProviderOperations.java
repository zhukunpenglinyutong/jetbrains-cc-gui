package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.concurrent.CompletableFuture;

/**
 * Handles opencode provider/model discovery.
 *
 * The plugin does not edit opencode auth or provider config. It only asks the
 * user-managed opencode server for the currently available model list.
 */
public class OpenCodeProviderOperations {

    private static final Logger LOG = Logger.getInstance(OpenCodeProviderOperations.class);
    private static final Gson GSON = new Gson();

    private final HandlerContext context;

    public OpenCodeProviderOperations(HandlerContext context) {
        this.context = context;
    }

    public void handleGetOpenCodeModels() {
        String cwd = null;
        if (context.getSession() != null) {
            cwd = context.getSession().getCwd();
        }
        if ((cwd == null || cwd.isBlank()) && context.getProject() != null) {
            cwd = context.getProject().getBasePath();
        }
        final String finalCwd = cwd != null ? cwd : "";

        CompletableFuture.runAsync(() -> {
            JsonObject payload;
            if (context.getOpenCodeSDKBridge() == null) {
                payload = new JsonObject();
                payload.addProperty("success", false);
                payload.addProperty("error", "opencode bridge is not available");
            } else {
                payload = context.getOpenCodeSDKBridge().listModels(finalCwd);
            }

            String json = GSON.toJson(payload);
            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    context.callJavaScript("window.updateOpenCodeModels", context.escapeJs(json));
                } catch (Exception e) {
                    LOG.warn("[OpenCodeProviderOperations] Failed to deliver opencode models: " + e.getMessage());
                }
            });
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[OpenCodeProviderOperations] Failed to get opencode models: " + ex.getMessage(), ex);
            return null;
        });
    }
}

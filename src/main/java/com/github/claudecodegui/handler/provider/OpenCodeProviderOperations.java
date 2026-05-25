package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
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

    public void handleGetOpenCodeAuthorization() {
        deliverAuthorizationState(false);
    }

    public void handleAuthorizeOpenCode() {
        try {
            context.getSettingsService().setOpenCodeLocalConfigAuthorized(true);
            deliverAuthorizationState(true);
            ApplicationManager.getApplication().invokeLater(() -> context.callJavaScript(
                    "window.showSwitchSuccess",
                    context.escapeJs(ClaudeCodeGuiBundle.message("toast.openCodeLocalConfigAuthorizationEnabled"))));
        } catch (Exception e) {
            LOG.error("[OpenCodeProviderOperations] Failed to authorize opencode access: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs(e.getMessage())));
        }
    }

    public void handleRevokeOpenCodeAuthorization() {
        try {
            context.getSettingsService().setOpenCodeLocalConfigAuthorized(false);
            deliverAuthorizationState(true);
            ApplicationManager.getApplication().invokeLater(() -> context.callJavaScript(
                    "window.showSwitchSuccess",
                    context.escapeJs(ClaudeCodeGuiBundle.message("toast.openCodeLocalConfigAuthorizationRevoked"))));
        } catch (Exception e) {
            LOG.error("[OpenCodeProviderOperations] Failed to revoke opencode access: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs(e.getMessage())));
        }
    }

    public void handleGetOpenCodeModels() {
        runDiscovery("models", "window.updateOpenCodeModels", (bridge, cwd) -> bridge.listModels(cwd));
    }

    public void handleGetOpenCodeAgents() {
        runDiscovery("agents", "window.updateOpenCodeAgents", (bridge, cwd) -> bridge.listAgents(cwd));
    }

    public void handleGetOpenCodeCommands() {
        runDiscovery("commands", "window.updateOpenCodeCommands", (bridge, cwd) -> bridge.listCommands(cwd));
    }

    private void runDiscovery(String label, String callbackName, OpenCodeDiscovery discovery) {
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
            if (!isOpenCodeAuthorized()) {
                payload = failurePayload(ClaudeCodeGuiBundle.message("error.openCodeLocalAccessNotAuthorized"));
            } else if (context.getOpenCodeSDKBridge() == null) {
                payload = new JsonObject();
                payload.addProperty("success", false);
                payload.addProperty("error", "opencode bridge is not available");
            } else {
                payload = discovery.run(context.getOpenCodeSDKBridge(), finalCwd);
            }

            String json = GSON.toJson(payload);
            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    context.callJavaScript(callbackName, context.escapeJs(json));
                } catch (Exception e) {
                    LOG.warn("[OpenCodeProviderOperations] Failed to deliver opencode " + label + ": " + e.getMessage());
                }
            });
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[OpenCodeProviderOperations] Failed to get opencode " + label + ": " + ex.getMessage(), ex);
            return null;
        });
    }

    private void deliverAuthorizationState(boolean changed) {
        JsonObject payload = new JsonObject();
        payload.addProperty("authorized", isOpenCodeAuthorized());
        payload.addProperty("changed", changed);
        String json = GSON.toJson(payload);
        ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.updateOpenCodeAuthorization", context.escapeJs(json)));
    }

    private boolean isOpenCodeAuthorized() {
        try {
            return context.getSettingsService().isOpenCodeLocalConfigAuthorized();
        } catch (Exception e) {
            LOG.warn("[OpenCodeProviderOperations] Failed to read opencode authorization state: " + e.getMessage());
            return false;
        }
    }

    private JsonObject failurePayload(String error) {
        JsonObject payload = new JsonObject();
        payload.addProperty("success", false);
        payload.addProperty("error", error);
        return payload;
    }

    @FunctionalInterface
    private interface OpenCodeDiscovery {
        JsonObject run(com.github.claudecodegui.provider.opencode.OpenCodeSDKBridge bridge, String cwd);
    }
}

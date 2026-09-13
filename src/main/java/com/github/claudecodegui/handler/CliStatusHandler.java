package com.github.claudecodegui.handler;

import com.github.claudecodegui.cli.CliStatusDetector;
import com.github.claudecodegui.cli.CliToolStatus;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Frontend bridge for CLI install/version detection (Settings → CLI tab).
 *
 * <p>Messages:
 * <ul>
 *   <li>{@code get_cli_status:} — probe all known CLIs, push {@code window.updateCliStatus}</li>
 * </ul>
 *
 * <p>Does <strong>not</strong> install CLIs for the user; the UI only shows
 * install instructions when a tool is missing.
 */
public class CliStatusHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(CliStatusHandler.class);

    private static final String[] SUPPORTED_TYPES = {
            "get_cli_status",
    };

    private final Gson gson = new Gson();

    public CliStatusHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    @Override
    public boolean handle(String type, String content) {
        if (!"get_cli_status".equals(type)) {
            return false;
        }
        handleGetStatus();
        return true;
    }

    private void handleGetStatus() {
        CompletableFuture.runAsync(() -> {
            try {
                Map<String, CliToolStatus> statuses = CliStatusDetector.detectAll();
                JsonObject payload = new JsonObject();
                for (Map.Entry<String, CliToolStatus> entry : statuses.entrySet()) {
                    payload.add(entry.getKey(), toJson(entry.getValue()));
                }
                String json = gson.toJson(payload);
                ApplicationManager.getApplication().invokeLater(() ->
                        callJavaScript("window.updateCliStatus", escapeJs(json))
                );
            } catch (Exception e) {
                LOG.error("[CliStatusHandler] Failed to detect CLI status: " + e.getMessage(), e);
                JsonObject error = new JsonObject();
                error.addProperty("error", e.getMessage() != null ? e.getMessage() : "unknown error");
                String json = gson.toJson(error);
                ApplicationManager.getApplication().invokeLater(() ->
                        callJavaScript("window.updateCliStatus", escapeJs(json))
                );
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[CliStatusHandler] Unexpected error: " + ex.getMessage(), ex);
            return null;
        });
    }

    private JsonObject toJson(CliToolStatus status) {
        JsonObject obj = new JsonObject();
        obj.addProperty("id", status.getId());
        obj.addProperty("name", status.getName());
        obj.addProperty("binaryName", status.getBinaryName());
        obj.addProperty("installed", status.isInstalled());
        if (status.getVersion() != null) {
            obj.addProperty("version", status.getVersion());
        }
        if (status.getPath() != null) {
            obj.addProperty("path", status.getPath());
        }
        if (status.getError() != null) {
            obj.addProperty("error", status.getError());
        }
        return obj;
    }
}

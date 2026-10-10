package com.github.claudecodegui.handler;

import com.github.claudecodegui.clawbot.ClawBotGatewayRuntimeService;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.concurrent.Executor;
import java.util.function.Consumer;
import java.util.function.Supplier;

/** Exposes a sanitized, read-only gateway status to the settings webview. */
public final class ClawBotStatusHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {"get_clawbot_status"};

    private final Executor backgroundExecutor;
    private final Consumer<Runnable> uiScheduler;
    private final Supplier<JsonObject> statusSupplier;

    public ClawBotStatusHandler(HandlerContext context) {
        this(context, task -> AppExecutorUtil.getAppExecutorService().execute(task),
                task -> ApplicationManager.getApplication().invokeLater(task),
                () -> ClawBotGatewayRuntimeService.getInstance().statusSnapshot());
    }

    ClawBotStatusHandler(HandlerContext context, Executor backgroundExecutor,
                         Consumer<Runnable> uiScheduler, Supplier<JsonObject> statusSupplier) {
        super(context);
        this.backgroundExecutor = backgroundExecutor;
        this.uiScheduler = uiScheduler;
        this.statusSupplier = statusSupplier;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    @Override
    public boolean handle(String type, String content) {
        if (!matchesType(type, SUPPORTED_TYPES)) {
            return false;
        }
        // Never retain the webview dispatch gate while waiting for gateway locks or follower IPC.
        backgroundExecutor.execute(() -> {
            if (context.isDisposed()) {
                return;
            }
            String statusJson = statusSnapshot().toString();
            uiScheduler.accept(() -> {
                if (!context.isDisposed()) {
                    callJavaScript("window.onClawBotStatus", escapeJs(statusJson));
                }
            });
        });
        return true;
    }

    private JsonObject statusSnapshot() {
        try {
            return statusSupplier.get();
        } catch (RuntimeException ignored) {
            JsonObject status = new JsonObject();
            status.addProperty("state", "STOPPED");
            status.addProperty("transport", "MOCK");
            status.addProperty("transportState", "STOPPED");
            status.addProperty("sessionCount", 0);
            status.addProperty("senderAccessCount", 0);
            status.addProperty("bindingState", "UNKNOWN");
            status.addProperty("bindingRevision", 0);
            status.addProperty("bindingDiagnostic", "BINDING_STATUS_UNAVAILABLE");
            status.addProperty("pairingState", "IDLE");
            status.addProperty("pairingExpiresAt", 0);
            status.addProperty("pairingAttempt", 0);
            status.add("pairing", new JsonObject());
            return status;
        }
    }
}

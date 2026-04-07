package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.approval.PendingFileChangeApprovalService;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.reflect.TypeToken;
import com.intellij.openapi.diagnostic.Logger;
import org.jetbrains.annotations.NotNull;

import java.lang.reflect.Type;
import java.util.Collections;
import java.util.List;

/**
 * Syncs frontend-computed file changes to a native IDE approval service.
 */
public class PendingFileChangeSyncHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(PendingFileChangeSyncHandler.class);
    private static final Gson GSON = new Gson();
    private static final Type FILE_LIST_TYPE =
            new TypeToken<List<PendingFileChangeApprovalService.PendingFileChangePayload>>() {}.getType();
    private static final String[] SUPPORTED_TYPES = {"sync_pending_file_changes"};

    public PendingFileChangeSyncHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if (!"sync_pending_file_changes".equals(type)) {
            return false;
        }

        // Gate: only process when experimental inline diff review is enabled
        try {
            String projectPath = context.getProject().getBasePath();
            boolean featureEnabled = new CodemossSettingsService().getExperimentalInlineDiffEnabled(projectPath);
            if (!featureEnabled) {
                return true; // consumed but no-op
            }
        } catch (Exception e) {
            LOG.warn("Failed to check experimental inline diff setting, skipping sync", e);
            return true;
        }

        try {
            JsonObject request = GSON.fromJson(content, JsonObject.class);
            List<PendingFileChangeApprovalService.PendingFileChangePayload> files =
                    request != null && request.has("files") && request.get("files").isJsonArray()
                            ? GSON.fromJson(request.get("files"), FILE_LIST_TYPE)
                            : Collections.emptyList();

            PendingFileChangeApprovalService.getInstance(context.getProject()).syncFromFrontend(
                    files != null ? files : Collections.emptyList(),
                    new BrowserCallbacksBridge(context)
            );
        } catch (Exception e) {
            LOG.error("Failed to sync pending file changes", e);
        }
        return true;
    }

    private static final class BrowserCallbacksBridge implements PendingFileChangeApprovalService.BrowserCallbacks {
        private final HandlerContext context;

        private BrowserCallbacksBridge(@NotNull HandlerContext context) {
            this.context = context;
        }

        @Override
        public void sendRemoveFileFromEdits(@NotNull String filePath) {
            JsonObject payload = new JsonObject();
            payload.addProperty("filePath", filePath);
            invokeJs("handleRemoveFileFromEdits", payload);
        }

        @Override
        public void sendDiffResult(@NotNull String filePath, @NotNull String action, String content, String error) {
            JsonObject payload = new JsonObject();
            payload.addProperty("filePath", filePath);
            payload.addProperty("action", action);
            if (content != null) {
                payload.addProperty("content", content);
            }
            if (error != null) {
                payload.addProperty("error", error);
            }
            invokeJs("handleDiffResult", payload);
        }

        private void invokeJs(@NotNull String functionName, @NotNull JsonObject payload) {
            String payloadJson = GSON.toJson(payload);
            String js = "(function() {" +
                    "  if (typeof window." + functionName + " === 'function') {" +
                    "    window." + functionName + "('" + JsUtils.escapeJs(payloadJson) + "');" +
                    "  }" +
                    "})();";
            context.executeJavaScriptOnEDT(js);
        }
    }
}

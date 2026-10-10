package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.hooks.HookCatalogService;
import com.github.claudecodegui.hooks.HookMutationService;
import com.github.claudecodegui.hooks.HookToggleService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.concurrent.CompletableFuture;

/** Handles Hooks discovery and guarded source mutations for the settings page. */
public class HookHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(HookHandler.class);
    private static final Gson GSON = new Gson();
    private static final String[] SUPPORTED_TYPES = {
        "get_hooks",
        "get_hook_source",
        "save_hook_source",
        "restore_hook_source",
        "toggle_hook"
    };

    private final HookCatalogService catalogService;
    private final HookMutationService mutationService;
    private final HookToggleService toggleService;

    public HookHandler(HandlerContext context) {
        this(context, new HookCatalogService(), new HookMutationService(
                java.nio.file.Paths.get(com.github.claudecodegui.bridge.NodeDetector.resolveHomeForFileOps())));
    }

    HookHandler(HandlerContext context, HookCatalogService catalogService) {
        this(context, catalogService, new HookMutationService(
                java.nio.file.Paths.get(com.github.claudecodegui.bridge.NodeDetector.resolveHomeForFileOps())));
    }

    HookHandler(HandlerContext context, HookCatalogService catalogService, HookMutationService mutationService) {
        super(context);
        this.catalogService = catalogService;
        this.mutationService = mutationService;
        this.toggleService = new HookToggleService(
                java.nio.file.Paths.get(com.github.claudecodegui.bridge.NodeDetector.resolveHomeForFileOps()));
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_hooks":
                handleGetHooks();
                return true;
            case "get_hook_source":
                handleGetHookSource(content);
                return true;
            case "save_hook_source":
                handleSaveHookSource(content);
                return true;
            case "restore_hook_source":
                handleRestoreHookSource(content);
                return true;
            case "toggle_hook":
                handleToggleHook(content);
                return true;
            default:
                return false;
        }
    }

    private void handleGetHookSource(String content) {
        handleMutation(content, "window.hookSourceResult", (json, projectRoot) -> mutationService.read(
                projectRoot, requiredString(json, "location")));
    }

    private void handleSaveHookSource(String content) {
        handleMutation(content, "window.hookMutationResult", (json, projectRoot) -> mutationService.write(
                projectRoot,
                requiredString(json, "location"),
                requiredString(json, "expectedRevision"),
                requiredString(json, "content")));
    }

    private void handleRestoreHookSource(String content) {
        handleMutation(content, "window.hookMutationResult", (json, projectRoot) -> mutationService.restore(
                projectRoot,
                requiredString(json, "location"),
                requiredString(json, "expectedRevision"),
                requiredString(json, "backupPath")));
    }

    private void handleToggleHook(String content) {
        try {
            JsonObject json = GSON.fromJson(content, JsonObject.class);
            String projectRoot = context.getProject() == null ? null : context.getProject().getBasePath();
            CompletableFuture
                    .supplyAsync(() -> attachRequestedLocation(toggleService.toggle(projectRoot, json), json),
                            AppExecutorUtil.getAppExecutorService())
                    .thenAccept(result -> ApplicationManager.getApplication().invokeLater(() ->
                            callJavaScript("window.hookToggleResult", escapeJs(GSON.toJson(result)))));
        } catch (RuntimeException e) {
            callJavaScript("window.hookToggleResult", escapeJs(GSON.toJson(failure("INVALID_REQUEST"))));
        }
    }

    private void handleMutation(String content, String callback, Mutation mutation) {
        try {
            JsonObject json = GSON.fromJson(content, JsonObject.class);
            String projectRoot = context.getProject() == null ? null : context.getProject().getBasePath();
            CompletableFuture
                    .supplyAsync(() -> {
                        try {
                            return attachRequestedLocation(mutation.apply(json, projectRoot), json);
                        } catch (RuntimeException e) {
                            return failure("INVALID_REQUEST");
                        }
                    }, AppExecutorUtil.getAppExecutorService())
                    .thenAccept(result -> ApplicationManager.getApplication().invokeLater(() ->
                            callJavaScript(callback, escapeJs(GSON.toJson(result)))));
        } catch (RuntimeException e) {
            callJavaScript(callback, escapeJs(GSON.toJson(failure("INVALID_REQUEST"))));
        }
    }

    private static String requiredString(JsonObject json, String key) {
        if (json == null || !json.has(key) || !json.get(key).isJsonPrimitive()) {
            throw new IllegalArgumentException(key);
        }
        return json.get(key).getAsString();
    }

    private static JsonObject failure(String errorCode) {
        JsonObject result = new JsonObject();
        result.addProperty("success", false);
        result.addProperty("errorCode", errorCode);
        return result;
    }

    static JsonObject attachRequestedLocation(JsonObject result, JsonObject request) {
        if (!result.has("location") && request.has("location")
                && request.get("location").isJsonPrimitive()) {
            result.addProperty("location", request.get("location").getAsString());
        }
        attachRequestedField(result, request, "sourceId");
        attachRequestedField(result, request, "requestId");
        return result;
    }

    private static void attachRequestedField(JsonObject result, JsonObject request, String field) {
        if (!result.has(field) && request.has(field) && request.get(field).isJsonPrimitive()) {
            result.add(field, request.get(field).deepCopy());
        }
    }

    @FunctionalInterface
    private interface Mutation {
        JsonObject apply(JsonObject json, String projectRoot);
    }

    private void handleGetHooks() {
        CompletableFuture
                .supplyAsync(() -> catalogService.scan(
                        context.getProject() == null ? null : context.getProject().getBasePath()),
                        AppExecutorUtil.getAppExecutorService())
                .exceptionally(error -> {
                    LOG.warn("[HookHandler] Failed to scan hooks: " + error.getMessage(), error);
                    JsonObject fallback = new JsonObject();
                    fallback.addProperty("schemaVersion", 1);
                    fallback.add("items", new com.google.gson.JsonArray());
                    fallback.add("sources", new com.google.gson.JsonArray());
                    fallback.add("capabilities", new com.google.gson.JsonArray());
                    fallback.addProperty("readOnly", false);
                    return fallback;
                })
                .thenAccept(result -> ApplicationManager.getApplication().invokeLater(() ->
                        callJavaScript("window.updateHooks", escapeJs(GSON.toJson(result)))));
    }
}

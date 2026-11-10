package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.settings.SessionSupplierCatalog;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/** Conversation-only supplier selection; never mutates the globally active supplier. */
final class SessionSupplierOperations {
    private final HandlerContext context;
    private final Gson gson = new Gson();

    SessionSupplierOperations(HandlerContext context) {
        this.context = context;
    }

    private static final class SelectionException extends RuntimeException {
        private SelectionException(String message) {
            super(message);
        }
    }

    void handle(String content, boolean selecting) {
        JsonObject reply = new JsonObject();
        try {
            JsonObject request = gson.fromJson(content, JsonObject.class);
            String engine = SessionSupplierCatalog.text(request, "provider");
            reply.addProperty("provider", engine);
            reply.addProperty("requestId", SessionSupplierCatalog.text(request, "requestId"));
            if (context.getSession() == null || !engine.equals(context.getSession().getProvider()) || !SessionSupplierCatalog.supports(engine)) {
                throw new SelectionException("Session engine changed; refresh the supplier selection.");
            }
            SessionState state = context.getSession().getState();
            synchronized (state.getMessageStateLock()) {
                if (!engine.equals(state.getProvider()) || context.getSession().getState() != state) {
                    throw new SelectionException("Session engine changed; refresh the supplier selection.");
                }
                if (selecting) {
                    String expectedSession = request.has("sessionId") && !request.get("sessionId").isJsonNull()
                            ? request.get("sessionId").getAsString() : null;
                    if (!java.util.Objects.equals(expectedSession, state.getSessionId())
                            || !state.getRuntimeSessionEpoch().equals(SessionSupplierCatalog.text(request, "bindingToken"))) {
                        throw new SelectionException("Session changed; refresh the supplier selection.");
                    }
                    String id = SessionSupplierCatalog.text(request, "supplierId");
                    if (!SessionSupplierCatalog.available(context.getSettingsService(), engine, id)) {
                        throw new SelectionException("This supplier is unavailable. Select a configured supplier.");
                    }
                    if (request.has("thinkingEnabled")) {
                        if (!"claude".equals(engine) || !request.get("thinkingEnabled").isJsonPrimitive()
                                || !request.getAsJsonPrimitive("thinkingEnabled").isBoolean()) {
                            throw new SelectionException("Invalid thinking setting.");
                        }
                        boolean enabled = request.get("thinkingEnabled").getAsBoolean();
                        if (SessionSupplierCatalog.isNativeMode(id)) {
                            context.getSettingsService().setAlwaysThinkingEnabledInClaudeSettings(enabled);
                        } else if (!context.getSettingsService().setAlwaysThinkingEnabledInProvider(id, enabled)) {
                            throw new SelectionException("This supplier is unavailable. Select a configured supplier.");
                        }
                    }
                    state.setSupplierId(engine, id);
                    context.sessionPreferencesChanged();
                }
                reply.addProperty("supplierId", state.getSupplierId(engine));
                reply.addProperty("activeSupplierId", state.getRuntimeSupplierId(engine));
                reply.addProperty("busy", state.isBusy() || state.getExecutionState().hasLiveTurn());
                reply.addProperty("sessionId", state.getSessionId());
                reply.addProperty("bindingToken", state.getRuntimeSessionEpoch());
            }
            JsonArray entries = new JsonArray();
            String defaultId = SessionSupplierCatalog.defaultId(context.getSettingsService(), engine);
            JsonObject selected = null;
            for (JsonObject provider : SessionSupplierCatalog.providers(context.getSettingsService(), engine)) {
                String id = SessionSupplierCatalog.text(provider, "id");
                if (id.equals(SessionSupplierCatalog.text(reply, "supplierId"))) {
                    selected = provider;
                }
                JsonObject safe = new JsonObject();
                safe.addProperty("id", id);
                String name = SessionSupplierCatalog.text(provider, "name");
                safe.addProperty("name", name.isBlank() ? id : name);
                safe.addProperty("available", SessionSupplierCatalog.supportsConfiguration(engine, provider)
                        && (!SessionSupplierCatalog.isNativeMode(id) || id.equals(defaultId)));
                entries.add(safe);
            }
            reply.add("suppliers", entries);
            if ("claude".equals(engine)) {
                JsonObject modelEnv = new JsonObject();
                boolean thinking = true;
                JsonObject settings = new JsonObject();
                String selectedId = SessionSupplierCatalog.text(reply, "supplierId");
                if (SessionSupplierCatalog.isNativeMode(selectedId)) {
                    // Virtual login entries contain no settings. Read native configuration only while authorized.
                    if (selected != null && selectedId.equals(defaultId)) {
                        JsonObject nativeSettings = context.getSettingsService().readClaudeSettings();
                        if (nativeSettings != null) {
                            settings = nativeSettings;
                        }
                    }
                } else if (selected != null && selected.has("settingsConfig") && selected.get("settingsConfig").isJsonObject()) {
                    settings = selected.getAsJsonObject("settingsConfig");
                }
                if (!settings.isEmpty()) {
                    if (settings.has("alwaysThinkingEnabled") && settings.get("alwaysThinkingEnabled").isJsonPrimitive()
                            && settings.getAsJsonPrimitive("alwaysThinkingEnabled").isBoolean()) {
                        thinking = settings.get("alwaysThinkingEnabled").getAsBoolean();
                    }
                    if (settings.has("env") && settings.get("env").isJsonObject()) {
                        JsonObject env = settings.getAsJsonObject("env");
                        for (String key : new String[]{"ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
                                "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", "ANTHROPIC_DEFAULT_SONNET_MODEL",
                                "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"}) {
                            if (env.has(key) && env.get(key).isJsonPrimitive() && env.getAsJsonPrimitive(key).isString()) {
                                modelEnv.add(key, env.get(key).deepCopy());
                            }
                        }
                    }
                }
                reply.add("modelMappingEnv", modelEnv);
                reply.addProperty("thinkingEnabled", thinking);
                reply.add("modelCatalog", modelCatalog(settings));
            }
        } catch (Exception error) {
            reply.addProperty("error", error instanceof SelectionException ? error.getMessage()
                    : "Could not read conversation suppliers. Refresh and try again.");
        }
        context.callJavaScript("window.onSessionSuppliers", context.escapeJs(gson.toJson(reply)));
    }

    /** Match the native picker contract while returning display fields only. */
    private static JsonObject modelCatalog(JsonObject settings) {
        JsonObject picker = settings.has("modelPicker") && settings.get("modelPicker").isJsonObject()
                ? settings.getAsJsonObject("modelPicker") : new JsonObject();
        JsonArray models = new JsonArray();
        java.util.Map<String, JsonObject> modelsById = new java.util.HashMap<>();
        boolean hasOptions = picker.has("options") && picker.get("options").isJsonArray();
        if (hasOptions) {
            for (var value : picker.getAsJsonArray("options")) {
                if (!value.isJsonObject()) {
                    continue;
                }
                JsonObject option = value.getAsJsonObject();
                String rawModel = string(option, "model").trim();
                String id = rawModel.replaceAll("(?i)\\[1m\\]$", "");
                if (id.isEmpty()) {
                    continue;
                }
                JsonObject existing = modelsById.get(id);
                if (existing != null) {
                    if (!rawModel.equals(id)) {
                        existing.addProperty("supports1MContext", true);
                    }
                    continue;
                }
                JsonObject model = new JsonObject();
                model.addProperty("id", id);
                String label = string(option, "label").trim();
                model.addProperty("label", label.isEmpty() ? id : label);
                model.addProperty("supports1MContext", !rawModel.equals(id));
                if (option.has("description") && option.get("description").isJsonPrimitive()
                        && option.getAsJsonPrimitive("description").isString()) {
                    model.addProperty("description", option.get("description").getAsString());
                }
                models.add(model);
                modelsById.put(id, model);
            }
        }
        JsonObject env = settings.has("env") && settings.get("env").isJsonObject() ? settings.getAsJsonObject("env") : new JsonObject();
        String defaultModel = null;
        for (String candidate : new String[]{string(settings, "model"), string(env, "ANTHROPIC_MODEL"), string(env, "ANTHROPIC_DEFAULT_SONNET_MODEL")}) {
            if (!candidate.isBlank()) {
                defaultModel = candidate.trim().replaceAll("(?i)\\[1m\\]$", "");
                break;
            }
        }
        if (!modelsById.containsKey(defaultModel)) {
            defaultModel = models.isEmpty() ? null : models.get(0).getAsJsonObject().get("id").getAsString();
        }
        JsonObject catalog = new JsonObject();
        catalog.add("models", models);
        catalog.addProperty("defaultModel", defaultModel);
        catalog.addProperty("replaceBuiltInOptions", hasOptions && picker.has("replaceBuiltInOptions")
                && picker.get("replaceBuiltInOptions").isJsonPrimitive() && picker.getAsJsonPrimitive("replaceBuiltInOptions").isBoolean()
                && picker.get("replaceBuiltInOptions").getAsBoolean());
        return catalog;
    }

    private static String string(JsonObject object, String key) {
        return object.has(key) && object.get(key).isJsonPrimitive() && object.getAsJsonPrimitive(key).isString()
                ? object.get(key).getAsString() : "";
    }
}

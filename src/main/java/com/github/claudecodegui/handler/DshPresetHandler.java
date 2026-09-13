package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.SessionState;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

public class DshPresetHandler {
    private static final Logger LOG = Logger.getInstance(DshPresetHandler.class);

    private static final Gson GSON = new Gson();
    private final HandlerContext context;

    public DshPresetHandler(HandlerContext context) {
        this.context = context;
    }

    public void handleSetDshPreset(String content) {
        try {
            String preset = content;
            if (content != null && !content.isEmpty()) {
                JsonObject payload = GSON.fromJson(content, JsonObject.class);
                if (payload != null && payload.has("preset") && !payload.get("preset").isJsonNull()) {
                    preset = payload.get("preset").getAsString();
                }
            }
            if (!SessionState.isValidDshPreset(preset)) {
                return;
            }
            if (context.getSession() != null) {
                context.getSession().getState().setDshPreset(preset.trim());
            }
        } catch (Exception e) {
            LOG.warn("[DSH] Failed to set DSH agent preset: " + e.getMessage(), e);
        }
    }
}

package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.util.ArrayList;
import java.util.List;

/**
 * Handles provider ordering/sorting operations for both Claude and Codex providers.
 */
public class ProviderOrderingService {

    private static final Logger LOG = Logger.getInstance(ProviderOrderingService.class);
    private static final Gson GSON = new Gson();

    private final HandlerContext context;
    private final ClaudeProviderOperations claudeOps;
    private final CodexProviderOperations codexOps;

    public ProviderOrderingService(HandlerContext context, ClaudeProviderOperations claudeOps, CodexProviderOperations codexOps) {
        this.context = context;
        this.claudeOps = claudeOps;
        this.codexOps = codexOps;
    }

    /**
     * Save provider order after drag-and-drop sorting.
     */
    public void handleSortProviders(String content) {
        List<String> orderedIds = parseOrderedIds(content, "sorting");
        if (orderedIds == null) return;
        try {
            context.getSettingsService().saveProviderOrder(orderedIds);
            LOG.info("[ProviderHandler] Saved provider order: " + orderedIds);
            ApplicationManager.getApplication().invokeLater(claudeOps::handleGetProviders);
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to save provider order: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("Failed to save provider order: " + e.getMessage())));
        }
    }

    /**
     * Save Codex provider order after drag-and-drop sorting.
     */
    public void handleSortCodexProviders(String content) {
        List<String> orderedIds = parseOrderedIds(content, "Codex sorting");
        if (orderedIds == null) return;
        try {
            context.getSettingsService().saveCodexProviderOrder(orderedIds);
            LOG.info("[ProviderHandler] Saved Codex provider order: " + orderedIds);
            ApplicationManager.getApplication().invokeLater(codexOps::handleGetCodexProviders);
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to save Codex provider order: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("Failed to save provider order: " + e.getMessage())));
        }
    }

    /**
     * Parse orderedIds from sort request content. Returns null if invalid.
     */
    private List<String> parseOrderedIds(String content, String sortContext) {
        try {
            JsonObject data = GSON.fromJson(content, JsonObject.class);
            JsonArray orderedIdsArray = data.getAsJsonArray("orderedIds");
            if (orderedIdsArray == null || orderedIdsArray.isEmpty()) {
                LOG.warn("[ProviderHandler] No orderedIds provided for " + sortContext);
                return null;
            }
            List<String> orderedIds = new ArrayList<>();
            for (JsonElement e : orderedIdsArray) {
                orderedIds.add(e.getAsString());
            }
            return orderedIds;
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to parse orderedIds for " + sortContext + ": " + e.getMessage(), e);
            return null;
        }
    }
}

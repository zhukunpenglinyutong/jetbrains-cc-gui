package com.github.claudecodegui.ui;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Predicate;
import java.util.function.Supplier;

/**
 * Keys of the webview's persisted text drafts and the chat windows that own them.
 *
 * <p>A key is {@code scope:projectHash:window}. The window part is the chat window's random id,
 * which is never reused, so a closed window's draft can never be read again. The scope is a random
 * id kept in application properties: it is shared by every IDE process of this installation but
 * not by other installations whose pages share one client's storage (several Gateway hosts).
 * Pages delete the drafts in this scope that belong to no open window.</p>
 */
public final class DraftCacheKeys {

    private static final String SCOPE_PROPERTY = "ccgui.draftCacheScope";
    private static final DraftCacheKeys INSTANCE = new DraftCacheKeys(DraftCacheKeys::loadPersistentScope);

    private final Supplier<String> scopeLoader;
    private final Map<String, Predicate<String>> openWindows = new ConcurrentHashMap<>();
    private volatile String scope;

    DraftCacheKeys(Supplier<String> scopeLoader) {
        this.scopeLoader = scopeLoader;
    }

    public static DraftCacheKeys getInstance() {
        return INSTANCE;
    }

    /**
     * Registers an open chat window.
     *
     * @param pruner sends a {@link #openWindowsJson()} payload to the window's page and reports
     *               whether the page could take it
     * @return the window's draft key
     */
    public String register(String projectHash, String windowId, Predicate<String> pruner) {
        String key = scope() + ":" + projectHash + ":" + windowId;
        openWindows.put(key, pruner);
        return key;
    }

    /** Forgets a closed window and lets the first ready page delete its draft. */
    public void unregister(String key) {
        if (key == null || openWindows.remove(key) == null) {
            return;
        }
        String request = openWindowsJson();
        for (Predicate<String> pruner : openWindows.values()) {
            if (pruner.test(request)) {
                return;
            }
        }
    }

    /** The scope prefix and every open window's key, as consumed by {@code pruneClosedDrafts}. */
    public String openWindowsJson() {
        JsonArray open = new JsonArray();
        openWindows.keySet().forEach(open::add);
        JsonObject request = new JsonObject();
        request.addProperty("scope", scope() + ":");
        request.add("open", open);
        return request.toString();
    }

    private String scope() {
        String current = scope;
        if (current != null) {
            return current;
        }
        synchronized (this) {
            if (scope == null) {
                scope = scopeLoader.get();
            }
            return scope;
        }
    }

    private static String loadPersistentScope() {
        PropertiesComponent properties = PropertiesComponent.getInstance();
        String stored = properties.getValue(SCOPE_PROPERTY);
        if (stored == null || stored.isBlank()) {
            stored = UUID.randomUUID().toString();
            properties.setValue(SCOPE_PROPERTY, stored);
        }
        return stored;
    }
}

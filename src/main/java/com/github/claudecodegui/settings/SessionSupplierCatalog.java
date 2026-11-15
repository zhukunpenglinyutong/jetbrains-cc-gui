package com.github.claudecodegui.settings;

import com.google.gson.JsonObject;
import org.tomlj.Toml;

import java.util.List;

/** Resolves conversation supplier identities without switching the global configuration. */
public final class SessionSupplierCatalog {
    public static final String UNAVAILABLE = "__session_supplier_unavailable__";

    private SessionSupplierCatalog() {
    }

    public static boolean supports(String provider) {
        return "claude".equals(provider) || "codex".equals(provider);
    }

    public static List<JsonObject> providers(CodemossSettingsService settings, String provider) throws java.io.IOException {
        return "codex".equals(provider) ? settings.getCodexProviders() : settings.getClaudeProviders();
    }

    public static String defaultId(CodemossSettingsService settings, String provider) {
        try {
            JsonObject active = "codex".equals(provider) ? settings.getActiveCodexProvider() : settings.getActiveClaudeProvider();
            String id = active == null ? "" : text(active, "id");
            return id.isBlank() ? UNAVAILABLE : id;
        } catch (Exception error) {
            return UNAVAILABLE;
        }
    }

    public static JsonObject find(CodemossSettingsService settings, String provider, String id) throws java.io.IOException {
        if (!supports(provider) || id == null || id.isBlank() || UNAVAILABLE.equals(id)) {
            return null;
        }
        for (JsonObject entry : providers(settings, provider)) {
            if (id.equals(text(entry, "id"))) {
                return entry;
            }
        }
        return null;
    }

    /** Use the bound model mappings for pricing and capacity without exposing credentials to the webview. */
    public static JsonObject claudeSettings(CodemossSettingsService settings, String id) throws java.io.IOException {
        if (id == null || isNativeMode(id)) {
            return settings.readClaudeSettings();
        }
        JsonObject supplier = find(settings, "claude", id);
        return supplier != null && supplier.has("settingsConfig") && supplier.get("settingsConfig").isJsonObject()
                ? supplier.getAsJsonObject("settingsConfig") : new JsonObject();
    }

    /** Native local/login modes remain tied to their existing authorization. */
    public static boolean isNativeMode(String id) {
        return ProviderManager.LOCAL_SETTINGS_PROVIDER_ID.equals(id) || ProviderManager.CLI_LOGIN_PROVIDER_ID.equals(id)
                || CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID.equals(id);
    }

    public static boolean available(CodemossSettingsService settings, String provider, String id) {
        try {
            JsonObject entry = find(settings, provider, id);
            if (entry == null || !supportsConfiguration(provider, entry)) {
                return false;
            }
            if (isNativeMode(id)) {
                return id.equals(defaultId(settings, provider));
            }
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    /** Keep picker availability aligned with the Bridge's conversation override limits. */
    public static boolean supportsConfiguration(String provider, JsonObject entry) {
        if (!"codex".equals(provider) || isNativeMode(text(entry, "id"))) {
            return true;
        }
        try {
            var parsed = Toml.parse(text(entry, "configToml"));
            return !parsed.hasErrors() && !parsed.keySet().contains("mcp_servers") && !parsed.keySet().contains("skills");
        } catch (RuntimeException | StackOverflowError error) {
            // Parser diagnostics can contain supplier credentials; expose availability only.
            return false;
        }
    }

    public static String text(JsonObject object, String key) {
        return object.has(key) && object.get(key).isJsonPrimitive() ? object.get(key).getAsString() : "";
    }
}

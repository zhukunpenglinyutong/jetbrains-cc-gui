package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resolves the API key used for code completion.
 *
 * <p>An explicitly configured key always wins. Otherwise the key is borrowed
 * from an already-configured provider (Claude or Codex provider list) whose
 * base URL points at the same service — so users do not paste the same key
 * twice. Nothing is persisted: the provider list stays the single source of
 * truth and key rotations are picked up automatically.
 */
public final class CodeCompletionCredentialResolver {

    private static final Logger LOG = Logger.getInstance(CodeCompletionCredentialResolver.class);
    private static final String[] TOKEN_KEYS = {
            "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "apiKey"
    };
    /** {@code base_url = "https://…"} inside a codex provider's config.toml text. */
    private static final Pattern TOML_BASE_URL =
            Pattern.compile("(?m)^\\s*base_url\\s*=\\s*[\"']([^\"']+)[\"']");

    private CodeCompletionCredentialResolver() {
    }

    /** Resolved credential plus the provider it came from ("" when not borrowed). */
    public static final class Resolution {
        public final String apiKey;
        public final String sourceName;

        Resolution(String apiKey, String sourceName) {
            this.apiKey = apiKey;
            this.sourceName = sourceName;
        }
    }

    /** Resolve using the plugin config file. Never throws. */
    public static Resolution resolve(CodeCompletionSettings settings) {
        try {
            JsonObject config = new CodemossSettingsService().readConfig();
            return pick(settings, collectProviders(config));
        } catch (Exception e) {
            LOG.debug("[CodeCompletionCredentialResolver] failed to read providers: " + e.getMessage());
            return new Resolution(settings == null ? "" : settings.getApiKey(), "");
        }
    }

    static JsonObject[] collectProviders(JsonObject config) {
        List<JsonObject> out = new ArrayList<>();
        if (config == null) {
            return out.toArray(new JsonObject[0]);
        }
        for (String section : new String[] {"claude", "codex"}) {
            if (!config.has(section) || config.get(section).isJsonNull()
                    || !config.get(section).isJsonObject()) {
                continue;
            }
            JsonObject s = config.getAsJsonObject(section);
            if (!s.has("providers") || s.get("providers").isJsonNull() || !s.get("providers").isJsonObject()) {
                continue;
            }
            JsonObject providers = s.getAsJsonObject("providers");
            for (String id : providers.keySet()) {
                if (!providers.get(id).isJsonObject()) {
                    continue;
                }
                JsonObject p = providers.getAsJsonObject(id);
                if (p != null && !p.isJsonNull()) {
                    out.add(p);
                }
            }
        }
        return out.toArray(new JsonObject[0]);
    }

    static Resolution pick(CodeCompletionSettings settings, JsonObject[] providers) {
        if (settings == null) {
            return new Resolution("", "");
        }
        String explicit = settings.getApiKey();
        if (explicit != null && !explicit.isEmpty()) {
            return new Resolution(explicit, "");
        }
        String target = settings.getBaseUrl();
        if (providers != null) {
            for (JsonObject p : providers) {
                if (p == null) {
                    continue;
                }
                if (!sameHost(hostOfProvider(p), target)) {
                    continue;
                }
                String key = tokenOfProvider(p);
                if (!key.isEmpty()) {
                    return new Resolution(key, stringOf(p, "name"));
                }
            }
        }
        return new Resolution("", "");
    }

    /**
     * Host a provider points at, across the shapes the plugin actually writes:
     * a top-level {@code baseUrl} (cc-switch imports and older providers), the
     * provider's {@code settingsConfig.env} (providers created in the UI), or
     * the {@code base_url} line inside a codex provider's {@code configToml}.
     */
    static String hostOfProvider(JsonObject provider) {
        if (provider == null) {
            return "";
        }
        String direct = stringOf(provider, "baseUrl");
        if (!direct.isEmpty()) {
            return direct;
        }
        String fromEnv = envValue(provider, "ANTHROPIC_BASE_URL");
        if (!fromEnv.isEmpty()) {
            return fromEnv;
        }
        fromEnv = envValue(provider, "OPENAI_BASE_URL");
        if (!fromEnv.isEmpty()) {
            return fromEnv;
        }
        String toml = stringOf(provider, "configToml");
        if (!toml.isEmpty()) {
            Matcher m = TOML_BASE_URL.matcher(toml);
            if (m.find()) {
                return m.group(1);
            }
        }
        return "";
    }

    /**
     * Token a provider holds, across the same shapes. Codex providers keep
     * theirs as JSON text inside {@code authJson} ({@code {"OPENAI_API_KEY":…}}).
     */
    static String tokenOfProvider(JsonObject provider) {
        if (provider == null) {
            return "";
        }
        String direct = stringOf(provider, "apiKey");
        if (!direct.isEmpty()) {
            return direct;
        }
        for (String key : TOKEN_KEYS) {
            String value = envValue(provider, key);
            if (!value.isEmpty()) {
                return value;
            }
        }
        String authJson = stringOf(provider, "authJson");
        if (!authJson.isEmpty()) {
            try {
                JsonObject parsed = new Gson().fromJson(authJson, JsonObject.class);
                for (String key : TOKEN_KEYS) {
                    if (parsed != null && parsed.has(key) && !parsed.get(key).isJsonNull()) {
                        String value = parsed.get(key).getAsString();
                        if (value != null && !value.isEmpty()) {
                            return value;
                        }
                    }
                }
            } catch (Exception e) {
                LOG.debug("[CodeCompletionCredentialResolver] unreadable authJson: " + e.getMessage());
            }
        }
        return "";
    }

    /**
     * Value of a nested {@code env} entry: the provider's
     * {@code settingsConfig.env} (what the UI writes today) first, then a legacy
     * top-level {@code env}.
     */
    private static String envValue(JsonObject provider, String key) {
        for (String container : new String[] {"settingsConfig", null}) {
            JsonObject holder = provider;
            if (container != null) {
                if (!provider.has(container) || !provider.get(container).isJsonObject()) {
                    continue;
                }
                holder = provider.getAsJsonObject(container);
            }
            if (!holder.has("env") || !holder.get("env").isJsonObject()) {
                continue;
            }
            JsonObject env = holder.getAsJsonObject("env");
            if (env.has(key) && !env.get(key).isJsonNull()) {
                String value = env.get(key).getAsString();
                if (value != null && !value.isEmpty()) {
                    return value;
                }
            }
        }
        return "";
    }

    private static String stringOf(JsonObject o, String key) {
        if (o.has(key) && !o.get(key).isJsonNull()) {
            String v = o.get(key).getAsString();
            return v == null ? "" : v;
        }
        return "";
    }

    /**
     * True when both URLs point at the same service.
     *
     * <p>A provider on a subdomain of the target serves the same API, so that
     * direction matches. The reverse deliberately does not: it would hand
     * {@code deepseek.com}'s key to {@code api.deepseek.com}. An explicit port
     * is part of the identity — two local gateways on one host are two
     * different services — while an implicit one (or a port on only one side)
     * still matches.
     */
    static boolean sameHost(String a, String b) {
        String ha = CodeCompletionSettings.hostOf(a);
        String hb = CodeCompletionSettings.hostOf(b);
        if (ha.isEmpty() || hb.isEmpty()) {
            return false;
        }
        String la = ha.toLowerCase(Locale.ROOT);
        String lb = hb.toLowerCase(Locale.ROOT);
        if (!la.equals(lb) && !la.endsWith("." + lb)) {
            return false;
        }
        String pa = portOf(a);
        String pb = portOf(b);
        return pa.isEmpty() || pb.isEmpty() || pa.equals(pb);
    }

    private static String portOf(String url) {
        try {
            int port = URI.create(url == null ? "" : url.trim()).getPort();
            return port > 0 ? String.valueOf(port) : "";
        } catch (Exception e) {
            return "";
        }
    }
}

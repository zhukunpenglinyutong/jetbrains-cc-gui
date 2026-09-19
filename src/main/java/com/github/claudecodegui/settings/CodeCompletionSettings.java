package com.github.claudecodegui.settings;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;

/**
 * Pure DTO for the code-completion (FIM) configuration.
 *
 * <p>Speaks the OpenAI-compatible completions shape ({@code prompt} + {@code suffix}
 * → {@code choices[0].text}); the only per-platform difference we model is
 * {@code baseUrl} + {@code path}. Persistence lives in
 * {@link CodemossSettingsService}.
 */
public final class CodeCompletionSettings {

    public static final String PRESET_DEEPSEEK = "deepseek";
    public static final String PRESET_SILICONFLOW = "siliconflow";
    public static final String PRESET_CUSTOM = "custom";

    public static final String DEFAULT_PRESET = PRESET_DEEPSEEK;
    public static final String DEFAULT_BASE_URL = "https://api.deepseek.com";
    /** Path used by every OpenAI-compatible gateway. */
    public static final String DEFAULT_PATH = "/v1/completions";
    /** DeepSeek's FIM endpoint lives under /beta. */
    public static final String DEEPSEEK_PATH = "/beta/completions";
    public static final String DEEPSEEK_HOST = "api.deepseek.com";

    public static final String DEFAULT_MODEL = "deepseek-flash";
    public static final int DEFAULT_MAX_TOKENS = 256;
    public static final double DEFAULT_TEMPERATURE = 1.0;
    public static final double DEFAULT_TOP_P = 1.0;
    public static final int DEFAULT_DEBOUNCE_MS = 300;
    public static final List<String> DEFAULT_STOP = Arrays.asList("\n\n");

    private boolean enabled = false;
    private String preset = DEFAULT_PRESET;
    private String baseUrl = DEFAULT_BASE_URL;
    private String path = DEEPSEEK_PATH;
    private String apiKey = "";
    private String model = DEFAULT_MODEL;
    private int maxTokens = DEFAULT_MAX_TOKENS;
    private double temperature = DEFAULT_TEMPERATURE;
    private double topP = DEFAULT_TOP_P;
    private List<String> stop = new ArrayList<>(DEFAULT_STOP);
    private boolean ignoreEos = false;
    private int debounceMs = DEFAULT_DEBOUNCE_MS;

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }

    public String getPreset() { return preset; }
    public void setPreset(String preset) { this.preset = preset == null ? "" : preset.trim(); }

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl == null ? "" : baseUrl.trim(); }

    public String getPath() { return path; }
    public void setPath(String path) { this.path = path == null ? "" : path.trim(); }

    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey == null ? "" : apiKey.trim(); }

    public String getModel() { return model; }
    public void setModel(String model) { this.model = model == null ? "" : model.trim(); }

    public int getMaxTokens() { return maxTokens; }
    public void setMaxTokens(int maxTokens) { this.maxTokens = maxTokens; }

    public double getTemperature() { return temperature; }
    public void setTemperature(double temperature) { this.temperature = temperature; }

    public double getTopP() { return topP; }
    public void setTopP(double topP) { this.topP = topP; }

    public List<String> getStop() { return stop; }
    public void setStop(List<String> stop) { this.stop = stop == null ? new ArrayList<>() : new ArrayList<>(stop); }

    public boolean isIgnoreEos() { return ignoreEos; }
    public void setIgnoreEos(boolean ignoreEos) { this.ignoreEos = ignoreEos; }

    public int getDebounceMs() { return debounceMs; }
    public void setDebounceMs(int debounceMs) { this.debounceMs = debounceMs; }

    /** The path to use when the config does not carry one. */
    public static String defaultPathFor(String baseUrl, String preset) {
        if (PRESET_DEEPSEEK.equals(preset) || DEEPSEEK_HOST.equalsIgnoreCase(hostOf(baseUrl))) {
            return DEEPSEEK_PATH;
        }
        return DEFAULT_PATH;
    }

    /** Host of a URL, or "" when it cannot be parsed. Never throws. */
    public static String hostOf(String url) {
        if (url == null || url.trim().isEmpty()) {
            return "";
        }
        try {
            String host = URI.create(url.trim()).getHost();
            return host == null ? "" : host;
        } catch (Exception e) {
            return "";
        }
    }

    /** Mask a credential for display: first/last 4 chars, "****" between. */
    public static String maskApiKey(String apiKey) {
        if (apiKey == null || apiKey.isEmpty()) {
            return "";
        }
        if (apiKey.length() <= 8) {
            return "****";
        }
        return apiKey.substring(0, 4) + "****" + apiKey.substring(apiKey.length() - 4);
    }

    /** True when a value is one of our masked previews rather than a real key. */
    public static boolean looksMasked(String value) {
        return value != null && value.contains("****");
    }

    /**
     * Adopt the stored key when this instance carries one of our masked
     * previews (or nothing at all).
     *
     * <p>The webview never sees a real credential, so every round trip — save
     * and "test connection" alike — echoes either a mask or an empty field, and
     * both mean "keep what is stored".
     *
     * @param storedKey the persisted key, or "" when none is stored.
     */
    public void keepStoredKeyWhenMasked(String storedKey) {
        if (apiKey == null || apiKey.isEmpty() || looksMasked(apiKey)) {
            apiKey = storedKey == null ? "" : storedKey;
        }
    }

    /** Apply validation: invalid values fall back to defaults. */
    public void normalize() {
        if (!PRESET_DEEPSEEK.equals(preset) && !PRESET_SILICONFLOW.equals(preset) && !PRESET_CUSTOM.equals(preset)) {
            preset = DEFAULT_PRESET;
        }
        if (baseUrl == null || baseUrl.isEmpty()) {
            baseUrl = DEFAULT_BASE_URL;
        }
        while (baseUrl.endsWith("/")) {
            baseUrl = baseUrl.substring(0, baseUrl.length() - 1);
        }
        // A path must be a relative endpoint path — never an absolute URL.
        boolean absolute = path == null || path.isEmpty()
                || path.startsWith("http://") || path.startsWith("https://");
        if (absolute) {
            path = defaultPathFor(baseUrl, preset);
        } else if (!path.startsWith("/")) {
            path = "/" + path;
        }
        while (path.endsWith("/") && path.length() > 1) {
            path = path.substring(0, path.length() - 1);
        }
        if (model == null || model.isEmpty()) {
            model = DEFAULT_MODEL;
        }
        if (maxTokens < 1 || maxTokens > 8192) {
            maxTokens = DEFAULT_MAX_TOKENS;
        }
        if (temperature < 0 || temperature > 2) {
            temperature = DEFAULT_TEMPERATURE;
        }
        if (topP <= 0 || topP > 1) {
            topP = DEFAULT_TOP_P;
        }
        if (debounceMs < 0 || debounceMs > 5000) {
            debounceMs = DEFAULT_DEBOUNCE_MS;
        }
    }

    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("enabled", enabled);
        o.addProperty("preset", preset);
        o.addProperty("baseUrl", baseUrl);
        o.addProperty("path", path);
        o.addProperty("apiKey", apiKey);
        o.addProperty("model", model);
        o.addProperty("maxTokens", maxTokens);
        o.addProperty("temperature", temperature);
        o.addProperty("topP", topP);
        JsonArray stopArr = new JsonArray();
        for (String s : stop) {
            stopArr.add(s);
        }
        o.add("stop", stopArr);
        o.addProperty("ignoreEos", ignoreEos);
        o.addProperty("debounceMs", debounceMs);
        return o;
    }

    public static CodeCompletionSettings fromJson(JsonObject o) {
        CodeCompletionSettings s = new CodeCompletionSettings();
        if (o == null) {
            return s;
        }
        if (o.has("enabled") && !o.get("enabled").isJsonNull()) {
            s.setEnabled(o.get("enabled").getAsBoolean());
        }
        // Migration: v1 stored "source" instead of "preset".
        if (o.has("preset") && !o.get("preset").isJsonNull()) {
            s.setPreset(o.get("preset").getAsString());
        } else if (o.has("source") && !o.get("source").isJsonNull()) {
            s.setPreset(o.get("source").getAsString());
        }
        if (o.has("baseUrl") && !o.get("baseUrl").isJsonNull()) {
            s.setBaseUrl(o.get("baseUrl").getAsString());
        }
        s.setPath(o.has("path") && !o.get("path").isJsonNull() ? o.get("path").getAsString() : "");
        if (o.has("apiKey") && !o.get("apiKey").isJsonNull()) {
            s.setApiKey(o.get("apiKey").getAsString());
        }
        if (o.has("model") && !o.get("model").isJsonNull()) {
            s.setModel(o.get("model").getAsString());
        }
        if (o.has("maxTokens") && !o.get("maxTokens").isJsonNull()) {
            s.setMaxTokens(o.get("maxTokens").getAsInt());
        }
        if (o.has("temperature") && !o.get("temperature").isJsonNull()) {
            s.setTemperature(o.get("temperature").getAsDouble());
        }
        if (o.has("topP") && !o.get("topP").isJsonNull()) {
            s.setTopP(o.get("topP").getAsDouble());
        }
        if (o.has("stop") && o.get("stop").isJsonArray()) {
            List<String> stop = new ArrayList<>();
            for (int i = 0; i < o.getAsJsonArray("stop").size(); i++) {
                stop.add(o.getAsJsonArray("stop").get(i).getAsString());
            }
            s.setStop(stop);
        }
        if (o.has("ignoreEos") && !o.get("ignoreEos").isJsonNull()) {
            s.setIgnoreEos(o.get("ignoreEos").getAsBoolean());
        }
        if (o.has("debounceMs") && !o.get("debounceMs").isJsonNull()) {
            s.setDebounceMs(o.get("debounceMs").getAsInt());
        }
        s.normalize();
        return s;
    }

    public static CodeCompletionSettings fromJsonString(String json) {
        if (json == null || json.trim().isEmpty()) {
            return new CodeCompletionSettings();
        }
        try {
            return fromJson(JsonParser.parseString(json).getAsJsonObject());
        } catch (Exception e) {
            return new CodeCompletionSettings();
        }
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof CodeCompletionSettings)) {
            return false;
        }
        CodeCompletionSettings that = (CodeCompletionSettings) o;
        return enabled == that.enabled
                && maxTokens == that.maxTokens
                && Double.compare(that.temperature, temperature) == 0
                && Double.compare(that.topP, topP) == 0
                && ignoreEos == that.ignoreEos
                && debounceMs == that.debounceMs
                && Objects.equals(preset, that.preset)
                && Objects.equals(baseUrl, that.baseUrl)
                && Objects.equals(path, that.path)
                && Objects.equals(apiKey, that.apiKey)
                && Objects.equals(model, that.model)
                && Objects.equals(stop, that.stop);
    }

    @Override
    public int hashCode() {
        return Objects.hash(enabled, preset, baseUrl, path, apiKey, model,
                maxTokens, temperature, topP, stop, ignoreEos, debounceMs);
    }
}

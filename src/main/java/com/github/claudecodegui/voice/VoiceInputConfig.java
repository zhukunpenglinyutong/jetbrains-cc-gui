package com.github.claudecodegui.voice;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Speech-to-text settings read from the {@code voiceInput} section of ~/.codemoss/config.json.
 *
 * <p>The endpoint is always user-supplied: any OpenAI-compatible {@code /audio/transcriptions}
 * service works, and the plugin ships no default host.
 */
public record VoiceInputConfig(
        String baseUrl,
        String apiKey,
        String model,
        String language,
        boolean liveTranscription,
        List<String> fillerWords
) {

    public static final String CONFIG_KEY = "voiceInput";
    private static final int API_KEY_HINT_CHARS = 4;
    /** Plain HTTP would expose the key and audio on the network, so it is only accepted for this machine. */
    private static final Set<String> LOOPBACK_HOSTS = Set.of("localhost", "127.0.0.1", "[::1]", "::1");

    static final String FIELD_BASE_URL = "baseUrl";
    static final String FIELD_API_KEY = "apiKey";
    static final String FIELD_MODEL = "model";
    static final String FIELD_LANGUAGE = "language";
    static final String FIELD_LIVE = "liveTranscription";
    static final String FIELD_FILLER_WORDS = "fillerWords";
    private static final String[] TEXT_FIELDS = {FIELD_BASE_URL, FIELD_MODEL, FIELD_LANGUAGE, FIELD_API_KEY, FIELD_FILLER_WORDS};
    private static final String[] BOOLEAN_FIELDS = {FIELD_LIVE};
    /** Bounds the generated filler pattern; anything past these is ignored. */
    static final int MAX_FILLER_WORDS = 50;
    static final int MAX_FILLER_WORD_LENGTH = 40;

    /** Why a config cannot be used yet; the webview maps each code to a message. */
    public enum Problem {
        MISSING_ENDPOINT("missing_endpoint"),
        INVALID_ENDPOINT("invalid_endpoint"),
        INSECURE_ENDPOINT("insecure_endpoint"),
        MISSING_MODEL("missing_model");

        public final String code;

        Problem(String code) {
            this.code = code;
        }
    }

    /**
     * Reads the config; missing values stay empty and are reported by {@link #problem()}.
     *
     * @param root full codemoss config, may be null
     */
    public static VoiceInputConfig from(JsonObject root) {
        JsonObject section = section(root);
        return new VoiceInputConfig(
                stripTrailingSlashes(stringOr(section, FIELD_BASE_URL)),
                stringOr(section, FIELD_API_KEY),
                stringOr(section, FIELD_MODEL),
                stringOr(section, FIELD_LANGUAGE),
                booleanOr(section, FIELD_LIVE, true),
                parseFillerWords(stringOr(section, FIELD_FILLER_WORDS)));
    }

    public VoiceInputConfig {
        fillerWords = List.copyOf(fillerWords);
    }

    /**
     * Splits the comma- (or newline-) separated filler list, dropping blanks, duplicates
     * (case-insensitively) and anything past the size limits.
     */
    static List<String> parseFillerWords(String raw) {
        Map<String, String> unique = new LinkedHashMap<>();
        for (String part : raw.split("[,;\\n]")) {
            String word = part.strip();
            if (!word.isEmpty() && word.length() <= MAX_FILLER_WORD_LENGTH && unique.size() < MAX_FILLER_WORDS) {
                unique.putIfAbsent(word.toLowerCase(Locale.ROOT), word);
            }
        }
        return new ArrayList<>(unique.values());
    }

    /** Resolves the config as it would be after {@code update}, without touching {@code root}. */
    public static VoiceInputConfig preview(JsonObject root, JsonObject update) {
        JsonObject copy = root != null ? root.deepCopy() : new JsonObject();
        applyUpdate(copy, update);
        return from(copy);
    }

    /**
     * Applies a settings-screen update to the config root in place.
     *
     * <p>Only fields present in {@code update} change; an empty string removes a field. The
     * webview never receives the stored key, so it cannot echo it back by accident.
     */
    public static void applyUpdate(JsonObject root, JsonObject update) {
        JsonObject section = section(root);
        for (String field : TEXT_FIELDS) {
            if (update.has(field)) {
                putOrRemove(section, field, update.get(field));
            }
        }
        for (String field : BOOLEAN_FIELDS) {
            JsonElement value = update.get(field);
            if (value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean()) {
                section.addProperty(field, value.getAsBoolean());
            }
        }
        root.add(CONFIG_KEY, section);
    }

    /** Returns why this config cannot transcribe, or null when it can. */
    public Problem problem() {
        if (baseUrl.isEmpty()) {
            return Problem.MISSING_ENDPOINT;
        }
        URI uri;
        try {
            uri = new URI(baseUrl);
        } catch (URISyntaxException e) {
            return Problem.INVALID_ENDPOINT;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        // "/audio/transcriptions" is appended to the base URL, so a query or fragment would swallow it.
        if (uri.getHost() == null || !(scheme.equals("https") || scheme.equals("http"))
                || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            return Problem.INVALID_ENDPOINT;
        }
        if (scheme.equals("http") && !LOOPBACK_HOSTS.contains(uri.getHost().toLowerCase(Locale.ROOT))) {
            return Problem.INSECURE_ENDPOINT;
        }
        if (model.isEmpty()) {
            return Problem.MISSING_MODEL;
        }
        return null;
    }

    /** Settings-screen view: everything except the key itself. */
    public JsonObject toSettingsJson() {
        JsonObject json = new JsonObject();
        json.addProperty(FIELD_BASE_URL, baseUrl);
        json.addProperty(FIELD_MODEL, model);
        json.addProperty(FIELD_LANGUAGE, language);
        json.addProperty(FIELD_LIVE, liveTranscription);
        json.addProperty(FIELD_FILLER_WORDS, String.join(", ", fillerWords));
        json.addProperty("apiKeySet", hasApiKey());
        json.addProperty("apiKeyHint", apiKeyHint());
        return json;
    }

    /** Local servers often need no key; requests then go without an Authorization header. */
    public boolean hasApiKey() {
        return !apiKey.isEmpty();
    }

    public String transcriptionsUrl() {
        return baseUrl + "/audio/transcriptions";
    }

    @Override
    public String toString() {
        // Records print every component; keep the key out of logs and exception messages.
        return "VoiceInputConfig[baseUrl=" + baseUrl + ", apiKey=" + (hasApiKey() ? "<set>" : "<none>")
                + ", model=" + model + ", language=" + language + ", live=" + liveTranscription
                + ", fillerWords=" + fillerWords.size() + "]";
    }

    private String apiKeyHint() {
        if (apiKey.length() <= API_KEY_HINT_CHARS * 2) {
            return apiKey.isEmpty() ? "" : "…";
        }
        return "…" + apiKey.substring(apiKey.length() - API_KEY_HINT_CHARS);
    }

    private static JsonObject section(JsonObject root) {
        return root != null && root.has(CONFIG_KEY) && root.get(CONFIG_KEY).isJsonObject()
                ? root.getAsJsonObject(CONFIG_KEY)
                : new JsonObject();
    }

    private static void putOrRemove(JsonObject section, String field, JsonElement value) {
        String text = value != null && value.isJsonPrimitive() ? value.getAsString().trim() : "";
        if (text.isEmpty()) {
            section.remove(field);
        } else {
            section.addProperty(field, text);
        }
    }

    private static boolean booleanOr(JsonObject section, String key, boolean fallback) {
        JsonElement value = section.get(key);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean()
                ? value.getAsBoolean()
                : fallback;
    }

    private static String stringOr(JsonObject section, String key) {
        JsonElement value = section.get(key);
        return value == null || !value.isJsonPrimitive() ? "" : value.getAsString().trim();
    }

    private static String stripTrailingSlashes(String url) {
        int end = url.length();
        while (end > 0 && url.charAt(end - 1) == '/') {
            end--;
        }
        return url.substring(0, end);
    }
}

package com.github.claudecodegui.handler.history;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.List;
import java.util.regex.Pattern;

/**
 * One webview delete request: its targets, their provider and its correlation id.
 *
 * <p>The provider travels with the request. Native Codex history never sends
 * {@code load_history_data}, so the handler's last listed provider can belong
 * to another history view.</p>
 *
 * @param sessionIds validated session ids, possibly empty
 * @param provider the provider whose history is being deleted
 * @param requestId webview correlation id, or null for legacy payloads
 */
record HistoryDeleteRequest(List<String> sessionIds, String provider, String requestId) {

    private static final Pattern PROVIDER_PATTERN = Pattern.compile("^[a-z][a-z0-9-]{0,31}$");
    private static final Pattern REQUEST_ID_PATTERN = Pattern.compile("^[A-Za-z0-9._-]{1,64}$");

    /**
     * Parse {@code {sessionId|sessionIds, provider, requestId}}, a JSON id array, or a bare id.
     *
     * @param content raw webview payload
     * @param fallbackProvider provider used when the payload does not name a valid one
     * @return the parsed request; invalid ids are dropped
     */
    static HistoryDeleteRequest parse(String content, String fallbackProvider) {
        String trimmed = content == null ? "" : content.trim();
        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
            // Legacy single-delete payload: the bare session id.
            List<String> ids = HistoryDeleteService.isValidSessionId(trimmed) ? List.of(trimmed) : List.of();
            return new HistoryDeleteRequest(ids, fallbackProvider, null);
        }
        List<String> sessionIds = HistoryDeleteService.parseSessionIds(trimmed);
        JsonObject request = parseObject(trimmed);
        if (request == null) {
            return new HistoryDeleteRequest(sessionIds, fallbackProvider, null);
        }
        String sessionId = stringField(request, "sessionId");
        if (sessionIds.isEmpty() && sessionId != null && HistoryDeleteService.isValidSessionId(sessionId.trim())) {
            sessionIds = List.of(sessionId.trim());
        }
        String provider = stringField(request, "provider");
        String requestId = stringField(request, "requestId");
        return new HistoryDeleteRequest(sessionIds,
                provider != null && PROVIDER_PATTERN.matcher(provider).matches() ? provider : fallbackProvider,
                requestId != null && REQUEST_ID_PATTERN.matcher(requestId).matches() ? requestId : null);
    }

    private static JsonObject parseObject(String content) {
        try {
            JsonElement parsed = JsonParser.parseString(content);
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String stringField(JsonObject object, String field) {
        JsonElement value = object.get(field);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()
                ? value.getAsString() : null;
    }
}

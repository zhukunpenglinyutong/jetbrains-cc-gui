package com.github.claudecodegui.clawbot;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/** Persists sender-to-session routes in PasswordSafe rather than ordinary plugin state. */
final class ClawBotConversationRouteStore implements ClawBotMessageRouter.RouteStore {

    private static final String ROUTES_KEY = "conversation-routes";
    private static final int MAX_ROUTE_COUNT = 256;
    private static final int MAX_SENDER_ID_LENGTH = ClawBotInboundMessage.MAX_USER_ID_LENGTH;
    private static final int MAX_SESSION_HANDLE_LENGTH = 4096;

    private final ClawBotCredentialStore.SecretBackend backend;

    ClawBotConversationRouteStore() {
        this(new ClawBotCredentialStore.PasswordSafeBackend());
    }

    ClawBotConversationRouteStore(ClawBotCredentialStore.SecretBackend backend) {
        this.backend = Objects.requireNonNull(backend, "backend");
    }

    @Override
    public synchronized Map<String, String> load() throws IOException {
        String stored;
        try {
            stored = backend.read(ROUTES_KEY);
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_ROUTE_STORE_UNAVAILABLE", error);
        }
        if (stored == null || stored.isBlank()) {
            return Map.of();
        }
        try {
            JsonElement parsed = JsonParser.parseString(stored);
            if (!parsed.isJsonObject() || parsed.getAsJsonObject().size() > MAX_ROUTE_COUNT) {
                throw new IllegalArgumentException("Invalid route payload");
            }
            Map<String, String> routes = new LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> entry : parsed.getAsJsonObject().entrySet()) {
                String senderId = entry.getKey();
                JsonElement value = entry.getValue();
                if (!isValid(senderId, MAX_SENDER_ID_LENGTH)
                        || value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()
                        || !isValid(value.getAsString(), MAX_SESSION_HANDLE_LENGTH)) {
                    throw new IllegalArgumentException("Invalid route entry");
                }
                routes.put(senderId, value.getAsString());
            }
            return routes;
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_ROUTE_STORE_INVALID", error);
        }
    }

    @Override
    public synchronized void save(Map<String, String> routes) throws IOException {
        Objects.requireNonNull(routes, "routes");
        if (routes.size() > MAX_ROUTE_COUNT) {
            throw new IOException("CLAWBOT_ROUTE_LIMIT_REACHED");
        }
        JsonObject payload = new JsonObject();
        for (Map.Entry<String, String> entry : routes.entrySet()) {
            if (!isValid(entry.getKey(), MAX_SENDER_ID_LENGTH)
                    || !isValid(entry.getValue(), MAX_SESSION_HANDLE_LENGTH)) {
                throw new IOException("CLAWBOT_ROUTE_STORE_INVALID");
            }
            payload.addProperty(entry.getKey(), entry.getValue());
        }
        try {
            backend.write(ROUTES_KEY, payload.toString());
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_ROUTE_STORE_UNAVAILABLE", error);
        }
    }

    @Override
    public synchronized void clear() throws IOException {
        try {
            backend.clear(ROUTES_KEY);
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_ROUTE_STORE_UNAVAILABLE", error);
        }
    }

    private static boolean isValid(String value, int maxLength) {
        return value != null && !value.isBlank() && value.length() <= maxLength
                && value.chars().noneMatch(Character::isISOControl);
    }
}

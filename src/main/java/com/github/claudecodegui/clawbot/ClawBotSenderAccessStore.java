package com.github.claudecodegui.clawbot;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Keeps the explicitly authorized iLink sender IDs in PasswordSafe. */
final class ClawBotSenderAccessStore {

    private static final String SENDERS_KEY = "allowed-senders";
    private static final String LAST_USED_KEY = "allowed-sender-last-used";
    private static final int MAX_SENDER_COUNT = 256;
    private static final int PAGE_SIZE = 8;
    private static final int MAX_SENDER_ID_LENGTH = ClawBotInboundMessage.MAX_USER_ID_LENGTH;
    private static final long USAGE_PERSIST_INTERVAL_MILLIS = 60_000L;

    private final ClawBotCredentialStore.SecretBackend backend;
    private Set<String> allowedSenders;
    private Map<String, Long> lastUsedAt;
    private boolean unavailable;

    ClawBotSenderAccessStore() {
        this(new ClawBotCredentialStore.PasswordSafeBackend());
    }

    ClawBotSenderAccessStore(ClawBotCredentialStore.SecretBackend backend) {
        this.backend = Objects.requireNonNull(backend, "backend");
    }

    synchronized boolean isAllowed(String senderId) {
        try {
            return senderId != null && load().contains(senderId);
        } catch (IOException error) {
            return false;
        }
    }

    synchronized int count() {
        try {
            return load().size();
        } catch (IOException error) {
            return 0;
        }
    }

    synchronized SenderPage page(int offset) throws IOException {
        if (offset < 0 || offset > MAX_SENDER_COUNT) {
            throw new IOException("CLAWBOT_SENDER_PAGE_INVALID");
        }
        List<String> senders = List.copyOf(load());
        int pageOffset = Math.min(offset, senders.size());
        int end = Math.min(pageOffset + PAGE_SIZE, senders.size());
        Map<String, Long> usage = loadLastUsed();
        Map<String, Long> pageUsage = new LinkedHashMap<>();
        for (String senderId : senders.subList(pageOffset, end)) {
            Long timestamp = usage.get(senderId);
            if (timestamp != null) {
                pageUsage.put(senderId, timestamp);
            }
        }
        return new SenderPage(pageOffset, senders.size(), end < senders.size(), senders.subList(pageOffset, end), pageUsage);
    }

    synchronized boolean available() {
        try {
            load();
            return true;
        } catch (IOException error) {
            return false;
        }
    }

    synchronized void allow(String senderId) throws IOException {
        requireSenderId(senderId);
        Set<String> updated = new LinkedHashSet<>(load());
        if (updated.add(senderId)) {
            if (updated.size() > MAX_SENDER_COUNT) {
                throw new IOException("CLAWBOT_SENDER_LIMIT_REACHED");
            }
            save(updated);
            allowedSenders = updated;
        }
    }

    synchronized void revoke(String senderId) throws IOException {
        requireSenderId(senderId);
        Set<String> updated = new LinkedHashSet<>(load());
        if (updated.remove(senderId)) {
            save(updated);
            allowedSenders = updated;
            removeLastUsed(senderId);
        }
    }

    synchronized void recordUse(String senderId) {
        if (senderId == null || senderId.isBlank()) {
            return;
        }
        try {
            if (!load().contains(senderId)) {
                return;
            }
            Map<String, Long> usage = loadLastUsed();
            long now = System.currentTimeMillis();
            Long previous = usage.get(senderId);
            if (previous != null && now >= previous
                    && now - previous < USAGE_PERSIST_INTERVAL_MILLIS) {
                return;
            }
            Map<String, Long> updated = new LinkedHashMap<>(usage);
            updated.put(senderId, now);
            saveLastUsed(updated);
            lastUsedAt = updated;
        } catch (IOException | RuntimeException ignored) {
            // Usage metadata is diagnostic only and must not block an authorized message.
        }
    }

    synchronized void clear() throws IOException {
        try {
            backend.clear(SENDERS_KEY);
            backend.clear(LAST_USED_KEY);
        } catch (RuntimeException error) {
            allowedSenders = new LinkedHashSet<>();
            lastUsedAt = new LinkedHashMap<>();
            unavailable = true;
            throw new IOException("CLAWBOT_SENDER_STORE_UNAVAILABLE", error);
        }
        allowedSenders = new LinkedHashSet<>();
        lastUsedAt = new LinkedHashMap<>();
        unavailable = false;
    }

    private Set<String> load() throws IOException {
        if (unavailable) {
            throw new IOException("CLAWBOT_SENDER_STORE_UNAVAILABLE");
        }
        if (allowedSenders != null) {
            return allowedSenders;
        }
        String stored;
        try {
            stored = backend.read(SENDERS_KEY);
        } catch (RuntimeException error) {
            unavailable = true;
            throw new IOException("CLAWBOT_SENDER_STORE_UNAVAILABLE", error);
        }
        Set<String> loaded = new LinkedHashSet<>();
        if (stored != null && !stored.isBlank()) {
            try {
                JsonElement parsed = JsonParser.parseString(stored);
                if (!parsed.isJsonArray() || parsed.getAsJsonArray().size() > MAX_SENDER_COUNT) {
                    throw new IllegalArgumentException("Invalid sender payload");
                }
                for (JsonElement element : parsed.getAsJsonArray()) {
                    if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
                        throw new IllegalArgumentException("Invalid sender entry");
                    }
                    String senderId = element.getAsString();
                    requireSenderId(senderId);
                    loaded.add(senderId);
                }
            } catch (RuntimeException error) {
                unavailable = true;
                throw new IOException("CLAWBOT_SENDER_STORE_INVALID", error);
            }
        }
        allowedSenders = loaded;
        return allowedSenders;
    }

    private Map<String, Long> loadLastUsed() {
        if (lastUsedAt != null) {
            return lastUsedAt;
        }
        Map<String, Long> loaded = new LinkedHashMap<>();
        try {
            String stored = backend.read(LAST_USED_KEY);
            if (stored != null && !stored.isBlank()) {
                JsonElement parsed = JsonParser.parseString(stored);
                if (!parsed.isJsonObject() || parsed.getAsJsonObject().size() > MAX_SENDER_COUNT) {
                    throw new IllegalArgumentException("Invalid sender usage payload");
                }
                for (Map.Entry<String, JsonElement> entry : parsed.getAsJsonObject().entrySet()) {
                    requireSenderId(entry.getKey());
                    JsonElement value = entry.getValue();
                    if (value == null || !value.isJsonPrimitive()
                            || !value.getAsJsonPrimitive().isNumber()) {
                        throw new IllegalArgumentException("Invalid sender usage timestamp");
                    }
                    long timestamp = value.getAsLong();
                    if (timestamp < 0L) {
                        throw new IllegalArgumentException("Invalid sender usage timestamp");
                    }
                    loaded.put(entry.getKey(), timestamp);
                }
            }
        } catch (IOException | RuntimeException ignored) {
            loaded.clear();
        }
        lastUsedAt = loaded;
        return lastUsedAt;
    }

    private void saveLastUsed(Map<String, Long> usage) throws IOException {
        JsonObject payload = new JsonObject();
        for (Map.Entry<String, Long> entry : usage.entrySet()) {
            requireSenderId(entry.getKey());
            Long timestamp = entry.getValue();
            if (timestamp == null || timestamp < 0L) {
                throw new IOException("CLAWBOT_SENDER_USAGE_INVALID");
            }
            payload.addProperty(entry.getKey(), timestamp);
        }
        try {
            backend.write(LAST_USED_KEY, payload.toString());
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_SENDER_USAGE_UNAVAILABLE", error);
        }
    }

    private void removeLastUsed(String senderId) {
        Map<String, Long> usage = loadLastUsed();
        if (usage.remove(senderId) == null) {
            return;
        }
        try {
            saveLastUsed(usage);
            lastUsedAt = usage;
        } catch (IOException ignored) {
            // A stale diagnostic timestamp is preferable to failing a completed revoke.
        }
    }

    private void save(Set<String> senders) throws IOException {
        JsonArray payload = new JsonArray();
        senders.forEach(payload::add);
        try {
            backend.write(SENDERS_KEY, payload.toString());
        } catch (RuntimeException error) {
            unavailable = true;
            throw new IOException("CLAWBOT_SENDER_STORE_UNAVAILABLE", error);
        }
    }

    private static void requireSenderId(String senderId) throws IOException {
        if (senderId == null || senderId.isBlank() || senderId.length() > MAX_SENDER_ID_LENGTH
                || senderId.chars().anyMatch(Character::isISOControl)) {
            throw new IOException("CLAWBOT_SENDER_ID_INVALID");
        }
    }

    record SenderPage(int offset, int totalCount, boolean hasMore, List<String> senderIds,
                      Map<String, Long> lastUsedAt) {
        SenderPage {
            senderIds = List.copyOf(senderIds);
            lastUsedAt = Map.copyOf(lastUsedAt);
        }
    }
}

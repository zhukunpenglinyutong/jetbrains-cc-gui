package com.github.claudecodegui.clawbot;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.AtomicMoveNotSupportedException;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.Map;

/** Leader-owned, persisted protective limits; these are local policy, not published iLink quotas. */
final class ClawBotOutboundProtection {
    static final long WINDOW_MILLIS = 300_000L;
    static final int WINDOW_LIMIT = 6;
    static final int ORDINARY_LIMIT = 4;
    private final Path file;
    private final Deque<Long> attempts = new ArrayDeque<>();
    private final Map<String, Integer> ordinaryCounts = new LinkedHashMap<>();
    private final Map<String, String> lastInbound = new LinkedHashMap<>();
    private long cooldownUntil;
    private boolean loaded;

    ClawBotOutboundProtection(Path directory) {
        file = directory.resolve("outbound-protection.json");
    }

    synchronized void reload() {
        loaded = false;
        attempts.clear();
        ordinaryCounts.clear();
        lastInbound.clear();
        cooldownUntil = 0;
    }

    synchronized boolean acquire(long now, boolean ordinary) throws IOException {
        return acquire(now, ordinary, "");
    }

    synchronized boolean acquire(long now, boolean ordinary, String conversation) throws IOException {
        load();
        prune(now);
        if (now < cooldownUntil || attempts.size() >= (ordinary ? ORDINARY_LIMIT : WINDOW_LIMIT)
                || (ordinary && !conversation.isEmpty() && ordinaryCounts.getOrDefault(conversation, 0) >= 6)) {
            return false;
        }
        attempts.addLast(now);
        if (ordinary && !conversation.isEmpty()) {
            ordinaryCounts.merge(conversation, 1, Integer::sum);
            while (ordinaryCounts.size() > 256) {
                ordinaryCounts.remove(ordinaryCounts.keySet().iterator().next());
            }
        }
        save();
        return true;
    }

    synchronized void coolDown(long now) throws IOException {
        coolDown(now, WINDOW_MILLIS);
    }

    synchronized void coolDown(long now, long delay) throws IOException {
        load();
        cooldownUntil = Math.max(cooldownUntil, now + Math.max(WINDOW_MILLIS, Math.min(delay, 86_400_000L)));
        save();
    }

    synchronized void renewConversation(String conversation, String inboundId) throws IOException {
        load();
        if (!inboundId.equals(lastInbound.get(conversation))) {
            lastInbound.put(conversation, inboundId);
            ordinaryCounts.remove(conversation);
            while (lastInbound.size() > 256) {
                lastInbound.remove(lastInbound.keySet().iterator().next());
            }
            save();
        }
    }

    synchronized long nextAllowedAt(long now) throws IOException {
        load();
        prune(now);
        return Math.max(cooldownUntil, attempts.size() >= WINDOW_LIMIT ? attempts.getFirst() + WINDOW_MILLIS : now);
    }

    private void prune(long now) {
        while (!attempts.isEmpty() && attempts.getFirst() <= now - WINDOW_MILLIS) {
            attempts.removeFirst();
        }
    }

    private void load() throws IOException {
        if (loaded) {
            return;
        }
        if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > 65_536) {
                throw new IOException("CLAWBOT_SEND_PROTECTION_UNAVAILABLE");
            }
            try {
                JsonObject data = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
                JsonArray values = data.getAsJsonArray("attempts");
                if (values.size() > WINDOW_LIMIT) {
                    throw new IllegalArgumentException("Invalid attempt count");
                }
                long previous = 0;
                for (var value : values) {
                    long timestamp = value.getAsLong();
                    if (timestamp < previous) {
                        throw new IllegalArgumentException("Invalid timestamp");
                    }
                    attempts.add(timestamp);
                    previous = timestamp;
                }
                cooldownUntil = data.get("cooldownUntil").getAsLong();
                if (data.has("ordinaryCounts")) {
                    JsonObject counts = data.getAsJsonObject("ordinaryCounts");
                    if (counts.size() > 256) {
                        throw new IllegalArgumentException("Invalid budget count");
                    }
                    for (var entry : counts.entrySet()) {
                        int value = entry.getValue().getAsInt();
                        if (!entry.getKey().matches("[a-f0-9-]{36}") || value < 0 || value > 6) {
                            throw new IllegalArgumentException("Invalid budget");
                        }
                        ordinaryCounts.put(entry.getKey(), value);
                    }
                }
                if (data.has("lastInbound")) {
                    JsonObject inbound = data.getAsJsonObject("lastInbound");
                    if (inbound.size() > 256) {
                        throw new IllegalArgumentException("Invalid inbound count");
                    }
                    for (var entry : inbound.entrySet()) {
                        if (!entry.getKey().matches("[a-f0-9-]{36}") || !entry.getValue().getAsString().matches("[a-f0-9-]{36}")) {
                            throw new IllegalArgumentException("Invalid inbound identity");
                        }
                        lastInbound.put(entry.getKey(), entry.getValue().getAsString());
                    }
                }
            } catch (RuntimeException error) {
                attempts.clear();
                ordinaryCounts.clear();
                lastInbound.clear();
                throw new IOException("CLAWBOT_SEND_PROTECTION_UNAVAILABLE", error);
            }
        }
        loaded = true;
    }

    private void save() throws IOException {
        JsonObject data = new JsonObject();
        JsonArray values = new JsonArray();
        attempts.forEach(values::add);
        data.add("attempts", values);
        data.addProperty("cooldownUntil", cooldownUntil);
        JsonObject counts = new JsonObject();
        ordinaryCounts.forEach(counts::addProperty);
        data.add("ordinaryCounts", counts);
        JsonObject inbound = new JsonObject();
        lastInbound.forEach(inbound::addProperty);
        data.add("lastInbound", inbound);
        Files.createDirectories(file.getParent());
        Path temporary = Files.createTempFile(file.getParent(), "outbound-protection-", ".tmp");
        try {
            Files.writeString(temporary, data.toString(), StandardCharsets.UTF_8);
            try {
                Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }
}

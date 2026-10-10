package com.github.claudecodegui.clawbot;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

final class ClawBotExecutionJournal {

    private static final String FILE_NAME = "execution-journal.json";
    private static final int MAX_RECORD_COUNT = 2_048;
    private static final long MAX_FILE_SIZE = 768L * 1024L;
    private static final List<String> STATES = List.of("ACCEPTED", "DISPATCHED", "COMPLETED", "UNKNOWN");

    private final Path stateFile;
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private boolean loaded;

    ClawBotExecutionJournal(Path runtimeDirectory) {
        stateFile = Objects.requireNonNull(runtimeDirectory, "runtimeDirectory")
                .toAbsolutePath().normalize().resolve(FILE_NAME);
    }

    synchronized void load() throws IOException {
        if (loaded) {
            return;
        }
        Map<String, Entry> loadedEntries = new LinkedHashMap<>();
        if (Files.exists(stateFile, LinkOption.NOFOLLOW_LINKS)) {
            if (!Files.isRegularFile(stateFile, LinkOption.NOFOLLOW_LINKS)
                    || Files.size(stateFile) > MAX_FILE_SIZE) {
                throw new IOException("CLAWBOT_EXECUTION_JOURNAL_INVALID");
            }
            try {
                JsonElement parsed = JsonParser.parseString(Files.readString(stateFile, StandardCharsets.UTF_8));
                if (!parsed.isJsonArray() || parsed.getAsJsonArray().size() > MAX_RECORD_COUNT) {
                    throw new IOException("CLAWBOT_EXECUTION_JOURNAL_INVALID");
                }
                for (JsonElement element : parsed.getAsJsonArray()) {
                    Entry entry = readEntry(element);
                    if (loadedEntries.put(entry.messageId(), entry) != null) {
                        throw new IOException("CLAWBOT_EXECUTION_JOURNAL_INVALID");
                    }
                }
            } catch (com.google.gson.JsonParseException | IllegalStateException error) {
                throw new IOException("CLAWBOT_EXECUTION_JOURNAL_INVALID", error);
            }
        }
        entries.putAll(loadedEntries);
        long now = System.currentTimeMillis();
        boolean changed = false;
        var iterator = entries.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, Entry> item = iterator.next();
            Entry entry = item.getValue();
            if ("ACCEPTED".equals(entry.state()) || "DISPATCHED".equals(entry.state())) {
                item.setValue(entry.withState("UNKNOWN", Math.max(now, entry.updatedAt())));
                changed = true;
            } else if ("COMPLETED".equals(entry.state())) {
                iterator.remove();
                changed = true;
            }
        }
        if (changed) {
            save();
        }
        loaded = true;
    }

    synchronized boolean recordAccepted(ClawBotInboundMessage message, String sessionHandleId, long timestamp)
            throws IOException {
        load();
        Objects.requireNonNull(message, "message");
        requireSafeString(sessionHandleId, "sessionHandleId", 256);
        requireTimestamp(timestamp);
        ClawBotSessionTarget target = message.target();
        if (target == null) {
            throw new IOException("CLAWBOT_EXECUTION_TARGET_MISSING");
        }
        Entry current = entries.get(message.messageId());
        if (current != null) {
            return false;
        }
        if (entries.size() >= MAX_RECORD_COUNT) {
            throw new IOException("CLAWBOT_EXECUTION_JOURNAL_FULL");
        }
        Entry entry = new Entry(executionId(message.messageId()), message.messageId(), sessionHandleId,
                target.instanceId(), target.connectionEpoch(), target.provider(), target.generation(),
                "ACCEPTED", timestamp, timestamp);
        entries.put(message.messageId(), entry);
        try {
            save();
        } catch (IOException error) {
            entries.remove(message.messageId());
            throw error;
        }
        return true;
    }

    synchronized void rollbackAccepted(String messageId) throws IOException {
        load();
        requireSafeString(messageId, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH);
        Entry current = entries.get(messageId);
        if (current == null || !"ACCEPTED".equals(current.state())) {
            return;
        }
        entries.remove(messageId);
        try {
            save();
        } catch (IOException error) {
            entries.put(messageId, current);
            throw error;
        }
    }

    synchronized void markDispatched(String messageId, long timestamp) throws IOException {
        transition(messageId, "DISPATCHED", timestamp, List.of("ACCEPTED"));
    }

    synchronized void markCompleted(String messageId, long timestamp) throws IOException {
        load();
        requireSafeString(messageId, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH);
        requireTimestamp(timestamp);
        Entry current = entries.get(messageId);
        if (current == null || !List.of("ACCEPTED", "DISPATCHED", "UNKNOWN").contains(current.state())) {
            return;
        }
        if (timestamp < current.createdAt()) {
            throw new IOException("CLAWBOT_EXECUTION_TIMESTAMP_INVALID");
        }
        entries.remove(messageId);
        try {
            save();
        } catch (IOException error) {
            entries.put(messageId, current);
            throw error;
        }
    }

    synchronized void clear() throws IOException {
        if (Files.exists(stateFile, LinkOption.NOFOLLOW_LINKS)
                && !Files.isRegularFile(stateFile, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("CLAWBOT_EXECUTION_JOURNAL_INVALID");
        }
        Files.deleteIfExists(stateFile);
        entries.clear();
        loaded = true;
    }

    synchronized StatusSnapshot status() {
        try {
            load();
            int accepted = 0;
            int dispatched = 0;
            int completed = 0;
            int unknown = 0;
            for (Entry entry : entries.values()) {
                switch (entry.state()) {
                    case "ACCEPTED" -> accepted++;
                    case "DISPATCHED" -> dispatched++;
                    case "COMPLETED" -> completed++;
                    case "UNKNOWN" -> unknown++;
                    default -> throw new IllegalStateException("Invalid execution journal state");
                }
            }
            return new StatusSnapshot(true, accepted, dispatched, completed, unknown);
        } catch (IOException | RuntimeException error) {
            return new StatusSnapshot(false, 0, 0, 0, 0);
        }
    }

    private void transition(String messageId, String nextState, long timestamp, List<String> allowedStates)
            throws IOException {
        load();
        requireSafeString(messageId, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH);
        requireTimestamp(timestamp);
        Entry current = entries.get(messageId);
        if (current == null || !allowedStates.contains(current.state())) {
            return;
        }
        if (timestamp < current.createdAt()) {
            throw new IOException("CLAWBOT_EXECUTION_TIMESTAMP_INVALID");
        }
        entries.put(messageId, current.withState(nextState, timestamp));
        try {
            save();
        } catch (IOException error) {
            entries.put(messageId, current);
            throw error;
        }
    }

    private void save() throws IOException {
        JsonArray payload = new JsonArray();
        for (Entry entry : entries.values()) {
            JsonObject value = new JsonObject();
            value.addProperty("executionId", entry.executionId());
            value.addProperty("messageId", entry.messageId());
            value.addProperty("sessionHandleId", entry.sessionHandleId());
            value.addProperty("instanceId", entry.instanceId());
            value.addProperty("connectionEpoch", entry.connectionEpoch());
            value.addProperty("provider", entry.provider());
            value.addProperty("generation", entry.generation());
            value.addProperty("state", entry.state());
            value.addProperty("createdAt", entry.createdAt());
            value.addProperty("updatedAt", entry.updatedAt());
            payload.add(value);
        }
        if (payload.toString().getBytes(StandardCharsets.UTF_8).length > MAX_FILE_SIZE) {
            throw new IOException("CLAWBOT_EXECUTION_JOURNAL_FULL");
        }
        Files.createDirectories(stateFile.getParent());
        Path temporary = Files.createTempFile(stateFile.getParent(), "execution-journal-", ".tmp");
        try {
            Files.writeString(temporary, payload.toString(), StandardCharsets.UTF_8);
            try {
                Files.move(temporary, stateFile, StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(temporary, stateFile, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static Entry readEntry(JsonElement element) throws IOException {
        if (element == null || !element.isJsonObject()) {
            throw new IOException("CLAWBOT_EXECUTION_JOURNAL_INVALID");
        }
        JsonObject value = element.getAsJsonObject();
        String executionId = readString(value, "executionId", 64);
        String messageId = readString(value, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH);
        String sessionHandleId = readString(value, "sessionHandleId", 256);
        String instanceId = readString(value, "instanceId", 256);
        long connectionEpoch = readNonNegativeLong(value, "connectionEpoch");
        String provider = readString(value, "provider", 256);
        String generation = readString(value, "generation", 256);
        String state = readString(value, "state", 16);
        if (!STATES.contains(state)) {
            throw new IOException("CLAWBOT_EXECUTION_JOURNAL_INVALID");
        }
        long createdAt = readNonNegativeLong(value, "createdAt");
        long updatedAt = readNonNegativeLong(value, "updatedAt");
        if (updatedAt < createdAt) {
            throw new IOException("CLAWBOT_EXECUTION_JOURNAL_INVALID");
        }
        try {
            UUID.fromString(executionId);
        } catch (IllegalArgumentException error) {
            throw new IOException("CLAWBOT_EXECUTION_JOURNAL_INVALID", error);
        }
        return new Entry(executionId, messageId, sessionHandleId, instanceId, connectionEpoch,
                provider, generation, state, createdAt, updatedAt);
    }

    private static String readString(JsonObject value, String name, int maxLength) throws IOException {
        JsonElement element = value.get(name);
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
            throw new IOException("CLAWBOT_EXECUTION_JOURNAL_INVALID");
        }
        return requireSafeString(element.getAsString(), name, maxLength);
    }

    private static long readNonNegativeLong(JsonObject value, String name) throws IOException {
        try {
            long result = value.get(name).getAsLong();
            if (result < 0L) {
                throw new NumberFormatException(name);
            }
            return result;
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_EXECUTION_JOURNAL_INVALID", error);
        }
    }

    private static String requireSafeString(String value, String name, int maxLength) throws IOException {
        if (value == null || value.isBlank() || value.length() > maxLength
                || value.chars().anyMatch(Character::isISOControl)) {
            throw new IOException("CLAWBOT_EXECUTION_" + name.toUpperCase(java.util.Locale.ROOT) + "_INVALID");
        }
        return value;
    }

    private static void requireTimestamp(long timestamp) throws IOException {
        if (timestamp < 0L) {
            throw new IOException("CLAWBOT_EXECUTION_TIMESTAMP_INVALID");
        }
    }

    private static String executionId(String messageId) {
        return UUID.nameUUIDFromBytes(("clawbot-execution:" + messageId)
                .getBytes(StandardCharsets.UTF_8)).toString();
    }

    record Entry(String executionId, String messageId, String sessionHandleId, String instanceId,
                 long connectionEpoch, String provider, String generation, String state,
                 long createdAt, long updatedAt) {

        Entry withState(String nextState, long timestamp) {
            return new Entry(executionId, messageId, sessionHandleId, instanceId, connectionEpoch,
                    provider, generation, nextState, createdAt, timestamp);
        }
    }

    record StatusSnapshot(boolean available, int acceptedCount, int dispatchedCount,
                          int completedCount, int unknownCount) {
    }
}

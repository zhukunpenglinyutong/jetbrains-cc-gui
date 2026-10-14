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
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;

/** Persists only the iLink cursor and bounded message IDs; credentials never enter this file. */
final class ClawBotTransportStateStore {

    private static final String FILE_NAME = "transport-state.json";
    static final int MAX_CURSOR_LENGTH = 128 * 1024;
    private static final int MAX_MESSAGE_ID_LENGTH = ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH;
    private static final int MAX_MESSAGE_COUNT = 2_048;
    private static final long MAX_FILE_SIZE = 2L * 1024L * 1024L;

    private final Path stateFile;

    ClawBotTransportStateStore(Path runtimeDirectory) {
        stateFile = Objects.requireNonNull(runtimeDirectory, "runtimeDirectory")
                .toAbsolutePath().normalize().resolve(FILE_NAME);
    }

    synchronized State load() throws IOException {
        if (!Files.exists(stateFile, LinkOption.NOFOLLOW_LINKS)) {
            return State.empty();
        }
        if (!Files.isRegularFile(stateFile, LinkOption.NOFOLLOW_LINKS)
                || Files.size(stateFile) > MAX_FILE_SIZE) {
            throw new IOException("CLAWBOT_TRANSPORT_STATE_INVALID");
        }
        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(stateFile, StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) {
                throw new IOException("CLAWBOT_TRANSPORT_STATE_INVALID");
            }
            JsonObject object = parsed.getAsJsonObject();
            String cursor = readOptionalString(object, "cursor", MAX_CURSOR_LENGTH);
            List<String> messageIds = readMessageIds(object.get("seenMessageIds"));
            List<String> uncertainMessageIds = readOptionalMessageIds(object.get("uncertainMessageIds"));
            return new State(cursor, messageIds, uncertainMessageIds);
        } catch (IllegalStateException | com.google.gson.JsonParseException error) {
            throw new IOException("CLAWBOT_TRANSPORT_STATE_INVALID", error);
        }
    }

    synchronized void save(String cursor, Collection<String> messageIds) throws IOException {
        save(cursor, messageIds, List.of());
    }

    synchronized void save(String cursor, Collection<String> messageIds, Collection<String> uncertainMessageIds)
            throws IOException {
        String safeCursor = requireSafeString(cursor, "cursor", MAX_CURSOR_LENGTH, true);
        Objects.requireNonNull(messageIds, "messageIds");
        Objects.requireNonNull(uncertainMessageIds, "uncertainMessageIds");
        LinkedHashSet<String> uniqueIds = new LinkedHashSet<>();
        for (String messageId : messageIds) {
            uniqueIds.add(requireSafeString(messageId, "messageId", MAX_MESSAGE_ID_LENGTH, false));
        }
        while (uniqueIds.size() > MAX_MESSAGE_COUNT) {
            uniqueIds.remove(uniqueIds.iterator().next());
        }
        LinkedHashSet<String> uniqueUncertainIds = new LinkedHashSet<>();
        for (String messageId : uncertainMessageIds) {
            String safeMessageId = requireSafeString(messageId, "uncertainMessageId", MAX_MESSAGE_ID_LENGTH, false);
            if (uniqueIds.contains(safeMessageId)) {
                uniqueUncertainIds.add(safeMessageId);
            }
        }
        while (uniqueUncertainIds.size() > MAX_MESSAGE_COUNT) {
            uniqueUncertainIds.remove(uniqueUncertainIds.iterator().next());
        }
        JsonObject object = new JsonObject();
        object.addProperty("cursor", safeCursor);
        JsonArray seen = new JsonArray();
        uniqueIds.forEach(seen::add);
        object.add("seenMessageIds", seen);
        JsonArray uncertain = new JsonArray();
        uniqueUncertainIds.forEach(uncertain::add);
        object.add("uncertainMessageIds", uncertain);
        Files.createDirectories(stateFile.getParent());
        Path temporary = Files.createTempFile(stateFile.getParent(), "transport-state-", ".tmp");
        try {
            Files.writeString(temporary, object.toString(), StandardCharsets.UTF_8);
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

    synchronized void clear() throws IOException {
        if (Files.exists(stateFile, LinkOption.NOFOLLOW_LINKS)
                && !Files.isRegularFile(stateFile, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("CLAWBOT_TRANSPORT_STATE_INVALID");
        }
        Files.deleteIfExists(stateFile);
    }

    private static List<String> readMessageIds(JsonElement element) throws IOException {
        if (element == null || !element.isJsonArray() || element.getAsJsonArray().size() > MAX_MESSAGE_COUNT) {
            throw new IOException("CLAWBOT_TRANSPORT_STATE_INVALID");
        }
        List<String> result = new ArrayList<>();
        for (JsonElement value : element.getAsJsonArray()) {
            if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
                throw new IOException("CLAWBOT_TRANSPORT_STATE_INVALID");
            }
            result.add(requireSafeString(value.getAsString(), "messageId", MAX_MESSAGE_ID_LENGTH, false));
        }
        return List.copyOf(new LinkedHashSet<>(result));
    }

    private static List<String> readOptionalMessageIds(JsonElement element) throws IOException {
        return element == null || element.isJsonNull() ? List.of() : readMessageIds(element);
    }

    private static String readOptionalString(JsonObject object, String name, int maxLength) throws IOException {
        JsonElement value = object.get(name);
        if (value == null || value.isJsonNull()) {
            return "";
        }
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IOException("CLAWBOT_TRANSPORT_STATE_INVALID");
        }
        return requireSafeString(value.getAsString(), name, maxLength, true);
    }

    private static String requireSafeString(String value, String name, int maxLength, boolean allowEmpty)
            throws IOException {
        if (value == null || value.length() > maxLength || (!allowEmpty && value.isEmpty())
                || value.chars().anyMatch(Character::isISOControl)) {
            throw new IOException("CLAWBOT_TRANSPORT_STATE_INVALID_" + name.toUpperCase());
        }
        return value;
    }

    record State(String cursor, List<String> seenMessageIds, List<String> uncertainMessageIds) {
        State {
            cursor = Objects.requireNonNull(cursor, "cursor");
            seenMessageIds = List.copyOf(Objects.requireNonNull(seenMessageIds, "seenMessageIds"));
            uncertainMessageIds = List.copyOf(Objects.requireNonNull(uncertainMessageIds, "uncertainMessageIds"));
        }

        State(String cursor, List<String> seenMessageIds) {
            this(cursor, seenMessageIds, List.of());
        }

        static State empty() {
            return new State("", List.of(), List.of());
        }
    }
}
